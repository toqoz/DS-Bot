// The Bot inbox MCP face: one streamable-HTTP endpoint on the profile's web server,
// Bearer authentication, a per-minute rate limit, and the tool definitions. It knows
// nothing about DS Bot's runtime; every tool goes through facade.js.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'

const PATH = '/bot/inbox/mcp'
const RATE_PER_MINUTE = 120
const REALM = 'ds-bot-inbox'
const DEFAULT_MAX_BODY_BYTES = 1_048_576

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  })
  res.end(JSON.stringify(body))
}

const bearerOf = (header) => {
  if (typeof header !== 'string') return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]
}

const digest = value => createHash('sha256').update(value).digest()

// Hash both sides before the constant-time compare: the result is independent of the
// token's length, so a wrong-length guess learns nothing from the comparison.
export const authorized = (header, token) => {
  if (typeof token !== 'string' || token === '') return false
  const given = bearerOf(header)
  return given !== undefined && timingSafeEqual(digest(given), digest(token))
}

const challenge = (error) => `Bearer realm="${REALM}"${error === undefined ? '' : `, error="${error}"`}`

const rateLimiter = (perMinute) => {
  const limit = Number.isFinite(perMinute) && perMinute > 0 ? Math.floor(perMinute) : RATE_PER_MINUTE
  let windowStart = 0
  let used = 0
  return () => {
    const now = Date.now()
    if (now - windowStart >= 60_000) {
      windowStart = now
      used = 0
    }
    used += 1
    if (used <= limit) return 0
    return Math.max(1, Math.ceil((windowStart + 60_000 - now) / 1000))
  }
}

// Which machine asked: the mcp-client row can send X-DS-Bot-Caller, otherwise the HTTP
// user agent is the only name a stateless request carries.
const callerOf = (extra) => {
  const headers = extra?.http?.req?.headers
  const get = name => (typeof headers?.get === 'function' ? headers.get(name) : undefined)
  return get('x-ds-bot-caller') ?? get('x-caller') ?? get('user-agent') ?? 'mcp'
}

const ok = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })
const failed = (error) => ({
  isError: true,
  content: [{
    type: 'text',
    text: JSON.stringify({
      error: {
        code: typeof error?.code === 'string' ? error.code : 'bot/error',
        message: error?.message ?? String(error),
      },
    }),
  }],
})

const objectSchema = (properties, required = []) => fromJsonSchema({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

export function createHandler({ facade, token, tokenOf, config = {}, warn = () => {} }) {
  const take = rateLimiter(config.requestsPerMinute)
  const resolveToken = typeof tokenOf === 'function' ? tokenOf : async () => token

  const register = (server) => {
    server.registerTool('targets', {
      description: 'List the Bots that accept work from outside, with the id (or name) to pass as ref, their role, model and permission preset.',
      inputSchema: objectSchema({}),
    }, async () => {
      try {
        return ok(await facade.targets())
      } catch (error) {
        return failed(error)
      }
    })

    server.registerTool('post', {
      description: 'Give a Bot a task. Returns at once with a taskId and the Session seq to read from; it does not wait for the answer. Use requestId to make a resend safe. freshPart starts a new conversation part: the Bot keeps its memory but not the chat history.',
      inputSchema: objectSchema({
        ref: { type: 'string', description: 'Bot id or name from targets' },
        text: { type: 'string', description: 'What to ask the Bot, in the user\'s own words' },
        freshPart: { type: 'boolean', description: 'Start a fresh conversation part before posting' },
        requestId: { type: 'string', description: 'Caller-chosen id; a second post with it is the same task' },
      }, ['ref', 'text']),
    }, async (args, extra) => {
      try {
        return ok(await facade.post(args.ref, args.text, {
          freshPart: args.freshPart === true,
          requestId: args.requestId,
          caller: callerOf(extra),
        }))
      } catch (error) {
        return failed(error)
      }
    })

    server.registerTool('read', {
      description: 'Read what the Bot has said since afterSeq, oldest first. Returns any approval or question waiting for an answer. If the Bot moved to a new part, reset is true and afterSeq restarts from that part.',
      inputSchema: objectSchema({
        ref: { type: 'string', description: 'Bot id or name from targets' },
        afterSeq: { type: 'integer', minimum: -1, description: 'Last seq the caller has seen; -1 reads from the first message' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Most messages to return (default 50)' },
      }, ['ref']),
    }, async (args) => {
      try {
        return ok(await facade.read(args.ref, { afterSeq: args.afterSeq, limit: args.limit }))
      } catch (error) {
        return failed(error)
      }
    })

    server.registerTool('wait', {
      description: 'Wait up to 25 seconds for progress: a new message, a waiting approval or question, or the turn ending. Returns the same shape as read.',
      inputSchema: objectSchema({
        ref: { type: 'string', description: 'Bot id or name from targets' },
        afterSeq: { type: 'integer', minimum: -1, description: 'Last seq the caller has seen; omitted waits from now' },
        timeoutMs: { type: 'integer', minimum: 0, maximum: 25000, description: 'Wait budget in milliseconds (default 20000, max 25000)' },
      }, ['ref']),
    }, async (args) => {
      try {
        return ok(await facade.wait(args.ref, { afterSeq: args.afterSeq, timeoutMs: args.timeoutMs }))
      } catch (error) {
        return failed(error)
      }
    })

    server.registerTool('answer', {
      description: 'Answer a waiting approval with allow or reject, or a waiting question with selected option labels and/or custom text. requestId is the pending item\'s requestId from read or wait.',
      inputSchema: objectSchema({
        ref: { type: 'string', description: 'Bot id or name from targets' },
        requestId: { type: 'string', description: 'The pending item\'s requestId' },
        answer: {
          anyOf: [
            { type: 'string' },
            {
              type: 'object',
              properties: {
                selected: { type: 'array', items: { type: 'string' } },
                custom: { type: 'string' },
                decision: { type: 'string', enum: ['allow', 'reject'] },
              },
              additionalProperties: false,
            },
          ],
        },
      }, ['ref', 'requestId', 'answer']),
    }, async (args) => {
      try {
        return ok(await facade.answer(args.ref, args.requestId, args.answer))
      } catch (error) {
        return failed(error)
      }
    })

    server.registerTool('stop', {
      description: 'Stop the Bot\'s running turn. It does not delete the Bot or its history.',
      inputSchema: objectSchema({
        ref: { type: 'string', description: 'Bot id or name from targets' },
      }, ['ref']),
    }, async (args) => {
      try {
        return ok(await facade.stop(args.ref))
      } catch (error) {
        return failed(error)
      }
    })
  }

  const allowedOrigins = Array.isArray(config.allowedOrigins)
    ? config.allowedOrigins.filter(value => typeof value === 'string' && value !== '')
    : []
  // A browser sends Origin; a CLI MCP client does not. With no allowlist, every
  // request that carries one is refused, which is the DNS-rebinding-safe default.
  const allowOrigin = (origin) => {
    if (typeof origin !== 'string' || origin === '') return true
    if (allowedOrigins.includes('*')) return true
    let normalized
    try { normalized = new URL(origin).origin } catch { return false }
    return allowedOrigins.some((value) => {
      try { return new URL(value).origin === normalized } catch { return value === normalized }
    })
  }
  const maxBodyBytes = Number.isFinite(config.maxBodyBytes) && config.maxBodyBytes > 0
    ? Math.floor(config.maxBodyBytes)
    : DEFAULT_MAX_BODY_BYTES

  const serve = async (req, res) => {
    if (!allowOrigin(req.headers.origin)) {
      json(res, 403, { error: 'Forbidden' })
      return
    }
    if (req.method !== 'POST') {
      json(res, 405, { error: 'Method Not Allowed' }, { Allow: 'POST' })
      return
    }
    const length = Number(req.headers['content-length'])
    if (Number.isFinite(length) && length > maxBodyBytes) {
      req.resume()
      json(res, 413, { error: 'Payload Too Large' })
      return
    }
    const secret = await resolveToken()
    if (typeof secret !== 'string' || secret === '') {
      json(res, 503, { error: 'Inbox MCP is not configured: no token is set' })
      return
    }
    const authorization = req.headers.authorization
    if (!authorized(authorization, secret)) {
      const present = typeof authorization === 'string' && authorization.trim() !== ''
      const bearer = bearerOf(authorization) !== undefined
      const error = present ? (bearer ? 'invalid_token' : 'invalid_request') : undefined
      json(res, 401, { error: error === undefined ? 'Unauthorized' : 'Invalid token' }, { 'WWW-Authenticate': challenge(error) })
      return
    }
    const retry = take()
    if (retry > 0) {
      json(res, 429, { error: 'Too many requests' }, { 'Retry-After': String(retry) })
      return
    }
    // Stateless: a client may initialize and call tools in separate requests, and a
    // new server for each request keeps no per-client memory to leak or lose.
    const server = new McpServer({ name: 'ds-bot-inbox', version: '1.0.0' })
    register(server)
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    await server.connect(transport)
    try {
      await transport.handleRequest(req, res)
    } finally {
      await server.close().catch(() => {})
    }
  }

  return (req, res) => {
    void serve(req, res).catch((error) => {
      warn('ds-bot: inbox request failed: %s', error)
      if (!res.headersSent) json(res, 500, { error: 'Inbox request failed' })
      else res.destroy()
    })
  }
}

// The launch environment is one source; a DSH credential is the other, so the token
// need not sit in the launchd/nix configuration. With autoToken an absent credential is
// generated once and saved there; only the ref is logged, never the value.
export function createTokenSource({ ctx, tokenEnv, tokenRef, autoToken, path, warn, log = () => {} }) {
  let generating
  let warnedNoStore = false
  let warnedMissing = false
  const prepare = async () => {
    const credentials = ctx.get?.('credentials')
    if (credentials === undefined) {
      if (!warnedNoStore) {
        warnedNoStore = true
        warn('ds-bot: inbox needs a credential store for %s; set %s in the environment instead', tokenRef, tokenEnv)
      }
      return undefined
    }
    try {
      const existing = (await credentials.resolve(tokenRef))?.value
      if (typeof existing === 'string' && existing !== '') return existing
      if (autoToken !== true) return undefined
      generating ??= (async () => {
        const again = (await credentials.resolve(tokenRef))?.value
        if (typeof again === 'string' && again !== '') return again
        const token = randomBytes(32).toString('base64url')
        await credentials.set(tokenRef, token)
        log(`ds-bot: generated an inbox token and stored it as credential ${tokenRef}; the value is not logged`)
        return token
      })().finally(() => { generating = undefined })
      return await generating
    } catch (error) {
      warn('ds-bot: inbox token %s could not be prepared: %s', tokenRef, error?.message ?? error)
      return undefined
    }
  }
  return async () => {
    const fromEnv = process.env[tokenEnv]
    if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
    const value = await prepare()
    if (typeof value === 'string' && value !== '') return value
    if (!warnedMissing) {
      warnedMissing = true
      warn('ds-bot: inbox MCP is mounted at %s but %s is not set in the environment or the credential store; requests get 503', path, tokenRef)
    }
    return undefined
  }
}

export function install(rt, { facade, config = {}, warn = rt.warn } = {}) {
  const ctx = rt.ctx
  if (typeof ctx?.webServer?.register !== 'function') return
  const tokenEnv = typeof config.tokenEnv === 'string' && config.tokenEnv.trim() !== '' ? config.tokenEnv.trim() : 'DS_BOT_INBOX_TOKEN'
  const tokenRef = typeof config.tokenRef === 'string' && config.tokenRef.trim() !== '' ? config.tokenRef.trim() : tokenEnv
  const path = typeof config.path === 'string' && config.path.startsWith('/') ? config.path : PATH
  const tokenOf = createTokenSource({
    ctx,
    tokenEnv,
    tokenRef,
    autoToken: config.autoToken === true,
    path,
    warn,
    log: message => ctx.logger?.info?.(message),
  })
  // Generate a missing autoToken at startup, not on the first request: a caller that
  // resolves the same credential may otherwise stay in waiting-credentials forever.
  if (config.autoToken === true) void tokenOf()
  const handler = createHandler({ facade, tokenOf, config, warn })
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }), 'ds-bot: inbox MCP')
}
