import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { authorized, createHandler, createTokenSource, install } from '../src/host/inbox/mcp.js'

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
}

const benchFacade = () => {
  const posted = []
  return {
    posted,
    targets: async () => ({ targets: [{ id: 'writer', name: 'Writer', role: 'Writes', model: 'p/m', permission: 'workspace' }] }),
    post: async (ref, text, options) => {
      posted.push({ ref, text, ...options })
      return { taskId: 't1', ref: 'writer', partSessionId: 'part-1', afterSeq: -1, state: 'posted' }
    },
    read: async () => ({ ref: 'writer', partSessionId: 'part-1', afterSeq: 1, events: [{ seq: 0, role: 'bot', text: 'Done.' }], pending: [], state: 'idle_continuable' }),
    wait: async () => ({ ref: 'writer', partSessionId: 'part-1', afterSeq: 1, events: [], pending: [], state: 'idle_continuable' }),
    answer: async (ref, requestId, answer) => ({ kind: 'approval', requestId, answered: answer }),
    stop: async () => ({ ref: 'writer', stopped: true }),
  }
}

async function listen(handler) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}/bot/inbox/mcp`,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

const post = (url, body, headers = {}) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
  body: JSON.stringify(body),
})

test('a request without the Bearer token is refused with 401 and a challenge', async () => {
  const host = await listen(createHandler({ facade: benchFacade(), token: 'secret' }))
  try {
    const missing = await post(host.url, initialize)
    assert.equal(missing.status, 401)
    assert.equal(missing.headers.get('www-authenticate'), 'Bearer realm="ds-bot-inbox"')

    const wrong = await post(host.url, initialize, { authorization: 'Bearer other' })
    assert.equal(wrong.status, 401)
    assert.equal(wrong.headers.get('www-authenticate'), 'Bearer realm="ds-bot-inbox", error="invalid_token"')

    const malformed = await post(host.url, initialize, { authorization: 'Basic other' })
    assert.equal(malformed.status, 401)
    assert.equal(malformed.headers.get('www-authenticate'), 'Bearer realm="ds-bot-inbox", error="invalid_request"')
  } finally {
    await host.close()
  }
})

test('only POST is served, and a declared body over the limit is refused', async () => {
  const host = await listen(createHandler({ facade: benchFacade(), token: 'secret', config: { maxBodyBytes: 16 } }))
  const auth = { authorization: 'Bearer secret' }
  try {
    const get = await fetch(host.url, { headers: auth })
    assert.equal(get.status, 405)
    assert.equal(get.headers.get('allow'), 'POST')

    const large = await post(host.url, initialize, auth)
    assert.equal(large.status, 413)
  } finally {
    await host.close()
  }
})

test('an Origin header must be on the allowlist', async () => {
  const host = await listen(createHandler({
    facade: benchFacade(),
    token: 'secret',
    config: { allowedOrigins: ['https://allowed.example'] },
  }))
  const auth = { authorization: 'Bearer secret' }
  try {
    const allowed = await post(host.url, initialize, { ...auth, origin: 'https://allowed.example' })
    assert.equal(allowed.status, 200)
    const refused = await post(host.url, initialize, { ...auth, origin: 'https://evil.example' })
    assert.equal(refused.status, 403)
    const absent = await post(host.url, initialize, auth)
    assert.equal(absent.status, 200)
  } finally {
    await host.close()
  }
})

test('requests are rate limited per minute after authentication', async () => {
  const host = await listen(createHandler({ facade: benchFacade(), token: 'secret', config: { requestsPerMinute: 1 } }))
  const auth = { authorization: 'Bearer secret' }
  try {
    const first = await post(host.url, initialize, auth)
    assert.equal(first.status, 200)
    const second = await post(host.url, initialize, auth)
    assert.equal(second.status, 429)
    assert.ok(Number(second.headers.get('retry-after')) >= 1)
  } finally {
    await host.close()
  }
})

test('without a configured token the endpoint reports 503 instead of serving', async () => {
  const host = await listen(createHandler({ facade: benchFacade(), token: undefined }))
  try {
    const response = await post(host.url, initialize, { authorization: 'Bearer anything' })
    assert.equal(response.status, 503)
  } finally {
    await host.close()
  }
})

test('a token resolver supplies the Bearer value without an environment variable', async () => {
  const host = await listen(createHandler({ facade: benchFacade(), tokenOf: async () => 'secret' }))
  try {
    const response = await post(host.url, initialize, { authorization: 'Bearer secret' })
    assert.equal(response.status, 200)
    const wrong = await post(host.url, initialize, { authorization: 'Bearer other' })
    assert.equal(wrong.status, 401)
  } finally {
    await host.close()
  }
})

test('an MCP client sees the tools and their calls reach the facade', async () => {
  const facade = benchFacade()
  const host = await listen(createHandler({ facade, token: 'secret' }))
  const client = new Client({ name: 'inbox-test', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(host.url), {
    requestInit: { headers: { authorization: 'Bearer secret', 'x-ds-bot-caller': 'bench' } },
  })
  try {
    await client.connect(transport)
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ['answer', 'post', 'read', 'stop', 'targets', 'wait'])

    const targets = await client.callTool({ name: 'targets', arguments: {} })
    assert.deepEqual(JSON.parse(targets.content[0].text).targets.map(bot => bot.id), ['writer'])

    const posted = await client.callTool({ name: 'post', arguments: { ref: 'writer', text: 'Do it', requestId: 'r1', freshPart: true } })
    assert.equal(JSON.parse(posted.content[0].text).taskId, 't1')
    assert.deepEqual(facade.posted, [{ ref: 'writer', text: 'Do it', freshPart: true, requestId: 'r1', caller: 'bench' }])

    const read = await client.callTool({ name: 'read', arguments: { ref: 'writer', afterSeq: -1 } })
    assert.equal(JSON.parse(read.content[0].text).events[0].text, 'Done.')

    const answered = await client.callTool({ name: 'answer', arguments: { ref: 'writer', requestId: 'a1', answer: 'allow' } })
    assert.equal(JSON.parse(answered.content[0].text).answered, 'allow')
  } finally {
    await client.close().catch(() => {})
    await host.close()
  }
})

test('Bearer comparison accepts only the exact token', () => {
  assert.equal(authorized('Bearer secret', 'secret'), true)
  assert.equal(authorized('bearer secret', 'secret'), true)
  assert.equal(authorized('Bearer secre', 'secret'), false)
  assert.equal(authorized('Bearer secret ', 'secret'), true)
  assert.equal(authorized('Bearer secre', 'secret'), false)
  assert.equal(authorized('Bearer secretlong', 'secret'), false)
  assert.equal(authorized('Basic secret', 'secret'), false)
  assert.equal(authorized(undefined, 'secret'), false)
  assert.equal(authorized('Bearer secret', ''), false)
})

const fakeCredentials = (initial = {}) => {
  const refs = new Map(Object.entries(initial))
  const sets = []
  return {
    refs,
    sets,
    resolve: async ref => (refs.has(ref) ? { value: refs.get(ref), source: 'file' } : undefined),
    set: async (ref, value) => { refs.set(ref, value); sets.push(ref) },
  }
}

test('autoToken generates once into the credential store and never logs the value', async () => {
  const credentials = fakeCredentials()
  const ctx = { get: name => (name === 'credentials' ? credentials : undefined) }
  const logs = []
  const warnings = []
  const source = createTokenSource({
    ctx, tokenEnv: 'INBOX_TEST_TOKEN', tokenRef: 'INBOX_TEST_TOKEN', autoToken: true,
    path: '/bot/inbox/mcp', warn: (...args) => warnings.push(args.join(' ')), log: message => logs.push(message),
  })
  const first = await source()
  assert.equal(typeof first, 'string')
  assert.equal(first.length, 43)
  assert.equal(credentials.refs.get('INBOX_TEST_TOKEN'), first)
  assert.deepEqual(credentials.sets, ['INBOX_TEST_TOKEN'])
  assert.equal(await source(), first)
  assert.equal(credentials.sets.length, 1)
  assert.equal(logs.length, 1)
  assert.match(logs[0], /INBOX_TEST_TOKEN/)
  assert.ok(!logs[0].includes(first))
  assert.deepEqual(warnings, [])
})

test('without autoToken an absent credential stays unset, and an existing one wins', async () => {
  const credentials = fakeCredentials()
  const ctx = { get: name => (name === 'credentials' ? credentials : undefined) }
  const source = createTokenSource({
    ctx, tokenEnv: 'INBOX_TEST_TOKEN', tokenRef: 'INBOX_TEST_TOKEN', autoToken: false,
    path: '/bot/inbox/mcp', warn: () => {},
  })
  assert.equal(await source(), undefined)
  assert.equal(credentials.refs.size, 0)

  const stored = fakeCredentials({ INBOX_TEST_TOKEN: 'from-the-store' })
  const storedSource = createTokenSource({
    ctx: { get: name => (name === 'credentials' ? stored : undefined) },
    tokenEnv: 'INBOX_TEST_TOKEN', tokenRef: 'INBOX_TEST_TOKEN', autoToken: true,
    path: '/bot/inbox/mcp', warn: () => {},
  })
  assert.equal(await storedSource(), 'from-the-store')
  assert.deepEqual(stored.sets, [])
})

test('the environment names the token and wins over generation', async () => {
  process.env.INBOX_TEST_TOKEN = 'from-the-environment'
  const credentials = fakeCredentials()
  const ctx = { get: name => (name === 'credentials' ? credentials : undefined) }
  const source = createTokenSource({
    ctx, tokenEnv: 'INBOX_TEST_TOKEN', tokenRef: 'INBOX_TEST_TOKEN', autoToken: true,
    path: '/bot/inbox/mcp', warn: () => {},
  })
  try {
    assert.equal(await source(), 'from-the-environment')
    assert.equal(credentials.refs.size, 0)
  } finally {
    delete process.env.INBOX_TEST_TOKEN
  }
})

test('install registers the route and prepares autoToken before any request', async () => {
  const credentials = fakeCredentials()
  const routes = []
  const ctx = {
    get: name => (name === 'credentials' ? credentials : undefined),
    logger: { info: () => {} },
    effect: run => { run() },
    webServer: { register: route => { routes.push(route); return () => {} } },
  }
  install({ ctx }, {
    facade: benchFacade(),
    config: { autoToken: true, tokenEnv: 'INBOX_INSTALL_TOKEN', tokenRef: 'INBOX_INSTALL_TOKEN' },
    warn: () => {},
  })
  assert.equal(routes.length, 1)
  assert.equal(routes[0].path, '/bot/inbox/mcp')
  assert.equal(routes[0].kind, 'exact')
  for (let i = 0; i < 20 && credentials.refs.size === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(typeof credentials.refs.get('INBOX_INSTALL_TOKEN'), 'string')
})
