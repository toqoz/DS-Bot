import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createFacade, readLimit, waitTimeoutMs } from '../src/host/inbox/facade.js'
import { createTasks } from '../src/host/inbox/tasks.js'

const team = () => ({
  version: 1,
  mainBotIds: [],
  bots: {
    writer: { id: 'writer', sessionId: 'part-1', name: 'Writer', role: 'Writes', model: 'p/m', permission: 'workspace' },
    other: { id: 'other', sessionId: 'other-1', name: 'Other', role: '', model: 'p/m' },
  },
  rooms: {},
  questions: {},
  revision: 1,
})

function bench({ config = {}, readOnly } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-inbox-'))
  const state = team()
  const events = new Map()
  const sent = []
  const newParts = []
  const approvals = []
  const answered = []
  const questionsAnswered = []
  let stopped = 0
  const list = part => events.get(part) ?? (events.set(part, []), events.get(part))
  const seq = part => list(part).length
  const rt = {
    state,
    home,
    config: { inbox: { targets: ['Writer'], ...config } },
    readOnly: () => readOnly,
    load: async () => {},
    botOf: id => (Object.hasOwn(state.bots, id) ? state.bots[id] : undefined),
    roomOf: id => (Object.hasOwn(state.rooms, id) ? state.rooms[id] : undefined),
    findBot: ref => (Object.hasOwn(state.bots, ref) ? state.bots[ref] : Object.values(state.bots).find(bot => bot.name === ref)),
    chatOf: id => state.bots[id]?.sessionId ?? id,
    resolveAgent: async id => ({ session: { id, seq: seq(id) } }),
    eventsBackwards: async function* (id) {
      for (const event of [...list(id)].reverse()) yield event
    },
    own: (table, key) => (table != null && Object.hasOwn(table, key) ? table[key] : undefined),
    sendUser: async ({ sessionId: ref, content, requestId }) => {
      const part = rt.chatOf(ref)
      list(part).push({ seq: seq(part), time: Date.now(), type: 'user/message', data: { content, source: { kind: 'user', rpcId: requestId } } })
      sent.push({ ref, content, requestId })
    },
    newPart: async part => {
      newParts.push(part)
      state.bots.writer.sessionId = 'part-2'
    },
    approvalsView: () => approvals.filter(entry => entry.answerable !== false),
    answerApproval: (id, choice) => {
      const at = approvals.findIndex(entry => entry.id === id)
      if (at === -1) throw new Error('stale')
      approvals.splice(at, 1)
      answered.push({ id, choice })
    },
    answerQuestion: async (ref, questionId, answer) => {
      questionsAnswered.push({ ref, questionId, answer })
      delete state.questions[rt.chatOf(ref)]
    },
    stopChat: async () => (stopped += 1) > 0,
    turnsView: () => ({}),
    workView: () => ({}),
    permissionCatalog: () => ({ options: [], defaultPreset: 'workspace' }),
    warn: () => {},
  }
  const tasks = createTasks({ home, warn: () => {} })
  const facade = createFacade(rt, { tasks, config: rt.config.inbox })
  const add = (part, text) => {
    const id = `${part}-${seq(part)}`
    list(part).push({ seq: seq(part), time: Date.now() + seq(part), type: 'assistant/message', data: { message: { id, content: [{ type: 'text', text }] } } })
  }
  return { home, state, rt, facade, tasks, events, sent, newParts, approvals, answered, questionsAnswered, add, stopped: () => stopped }
}

test('post sends the caller label and task id, and a repeated requestId sends nothing twice', async () => {
  const b = bench()
  const ack = await b.facade.post('Writer', 'Fix the report', { requestId: 'r1', caller: 'laptop\ncli' })
  assert.equal(b.sent.length, 1)
  assert.equal(b.sent[0].ref, 'writer')
  assert.equal(b.sent[0].requestId, 'r1')
  assert.match(b.sent[0].content[0].text, /^\[inbox: laptop cli · task [0-9a-f-]{36}\]\nFix the report$/)
  assert.equal(ack.partSessionId, 'part-1')
  assert.equal(ack.afterSeq, -1)
  assert.equal(ack.state, 'posted')

  const again = await b.facade.post('Writer', 'Fix the report', { requestId: 'r1' })
  assert.equal(b.sent.length, 1)
  assert.equal(again.taskId, ack.taskId)

  const other = await b.facade.post('writer', 'Another', { requestId: 'r2' })
  assert.notEqual(other.taskId, ack.taskId)
  assert.equal(b.sent.length, 2)

  const saved = JSON.parse(readFileSync(join(b.home, 'inbox', 'tasks.json'), 'utf8'))
  assert.equal(saved.tasks.length, 2)
  assert.equal(saved.tasks[0].requestId, 'r1')
  assert.equal(saved.tasks[0].caller, 'laptop cli')
  rmSync(b.home, { recursive: true, force: true })
})

test('read passes over the caller\'s own post and follows a move to a fresh part', async () => {
  const b = bench()
  const ack = await b.facade.post('writer', 'Do it', { requestId: 'r1' })
  b.add('part-1', 'Done.')
  const first = await b.facade.read('writer', { afterSeq: ack.afterSeq })
  assert.deepEqual(first.events.map(event => [event.role, event.text]), [['bot', 'Done.']])
  assert.equal(first.afterSeq, 1)
  assert.equal(first.state, 'idle_continuable')
  assert.equal(first.reset, undefined)

  b.state.bots.writer.sessionId = 'part-2'
  b.add('part-2', 'Starting again.')
  const second = await b.facade.read('writer', { afterSeq: 1 })
  assert.equal(second.reset, true)
  assert.equal(second.partSessionId, 'part-2')
  assert.deepEqual(second.events.map(event => event.text), ['Starting again.'])
  assert.equal(second.afterSeq, 0)
  rmSync(b.home, { recursive: true, force: true })
})

test('read and wait surface approvals and questions, and answer settles them', async () => {
  const b = bench()
  const ack = await b.facade.post('writer', 'Run it', { requestId: 'r1' })
  b.approvals.push({ id: 'a1', botId: 'writer', sessionId: 'part-1', tool: 'bash', reason: 'needs network', at: 5 })
  const waiting = await b.facade.read('writer', { afterSeq: ack.afterSeq })
  assert.equal(waiting.state, 'waiting_input')
  assert.deepEqual(waiting.pending.map(item => [item.kind, item.requestId, item.tool]), [['approval', 'a1', 'bash']])
  assert.deepEqual(await b.facade.answer('writer', 'a1', 'allow'), { kind: 'approval', requestId: 'a1', answered: 'allow' })
  assert.deepEqual(b.answered, [{ id: 'a1', choice: 'allow' }])

  b.state.questions['part-1'] = {
    id: 'q1', question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }],
    multiSelect: false, allowCustom: true, askedAt: 6,
  }
  const asked = await b.facade.read('writer', { afterSeq: waiting.afterSeq })
  assert.equal(asked.state, 'waiting_input')
  assert.deepEqual(asked.pending.map(item => [item.kind, item.requestId, item.question]), [['question', 'q1', 'Which one?']])
  assert.deepEqual(await b.facade.answer('writer', 'q1', { selected: ['B'], custom: 'or C' }), { kind: 'question', requestId: 'q1', answered: true })
  assert.deepEqual(b.questionsAnswered, [{ ref: 'writer', questionId: 'q1', answer: { selected: ['B'], custom: 'or C' } }])

  await assert.rejects(() => b.facade.answer('writer', 'missing', 'allow'), error => error.code === 'bot/stale')
  rmSync(b.home, { recursive: true, force: true })
})

test('wait returns on new output and on a newly waiting item, but not on the caller\'s own post', async () => {
  const b = bench()
  const ack = await b.facade.post('writer', 'Do it', { requestId: 'r1' })
  const pending = b.facade.wait('writer', { afterSeq: ack.afterSeq, timeoutMs: 2_000 })
  setTimeout(() => b.add('part-1', 'Progress.'), 40)
  const answered = await pending
  assert.deepEqual(answered.events.map(event => event.text), ['Progress.'])
  assert.equal(answered.state, 'idle_continuable')

  b.approvals.push({ id: 'a2', botId: 'writer', sessionId: 'part-1', tool: 'pwsh', reason: '', at: 9 })
  const immediate = await b.facade.wait('writer', { afterSeq: answered.afterSeq, timeoutMs: 2_000 })
  assert.equal(immediate.state, 'waiting_input')
  assert.equal(immediate.pending[0].requestId, 'a2')
  rmSync(b.home, { recursive: true, force: true })
})

test('freshPart asks for a new part before posting', async () => {
  const b = bench()
  const ack = await b.facade.post('writer', 'New job', { freshPart: true, requestId: 'r1' })
  assert.deepEqual(b.newParts, ['part-1'])
  assert.equal(b.sent[0].ref, 'writer')
  assert.equal(ack.partSessionId, 'part-1')
  rmSync(b.home, { recursive: true, force: true })
})

test('the allowlist limits targets and refuses other Bots; read-only refuses writes', async () => {
  const b = bench()
  assert.deepEqual(await b.facade.targets(), {
    targets: [{ id: 'writer', name: 'Writer', role: 'Writes', model: 'p/m', permission: 'workspace' }],
  })
  await assert.rejects(() => b.facade.post('Other', 'hi'), error => error.code === 'bot/forbidden')

  const ro = bench({ readOnly: 'Another dsh holds the team' })
  await assert.rejects(() => ro.facade.post('Writer', 'hi'), error => error.code === 'bot/read-only')
  await assert.rejects(() => ro.facade.answer('Writer', 'x', 'allow'), error => error.code === 'bot/read-only')
  await assert.rejects(() => ro.facade.stop('Writer'), error => error.code === 'bot/read-only')
  assert.equal((await ro.facade.read('Writer')).partSessionId, 'part-1')
  rmSync(b.home, { recursive: true, force: true })
  rmSync(ro.home, { recursive: true, force: true })
})

test('stop marks open tasks terminal', async () => {
  const b = bench()
  const ack = await b.facade.post('writer', 'Long job', { requestId: 'r1' })
  assert.deepEqual(await b.facade.stop('writer'), { ref: 'writer', stopped: true })
  const saved = JSON.parse(readFileSync(join(b.home, 'inbox', 'tasks.json'), 'utf8'))
  const task = saved.tasks.find(item => item.id === ack.taskId)
  assert.equal(task.terminal, true)
  assert.equal(task.state, 'terminal')
  rmSync(b.home, { recursive: true, force: true })
})

test('wait and read bounds clamp to the contract', () => {
  assert.equal(waitTimeoutMs(undefined), 20_000)
  assert.equal(waitTimeoutMs(60_000), 25_000)
  assert.equal(waitTimeoutMs(0), 0)
  assert.equal(waitTimeoutMs('x'), 20_000)
  assert.equal(readLimit(undefined), 50)
  assert.equal(readLimit(1_000), 200)
  assert.equal(readLimit(0), 50)
})
