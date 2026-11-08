// The one file that touches DS Bot's host runtime for work from other machines. mcp.js knows tools
// and HTTP, tasks.js knows the records; this maps a caller's ref onto the Bot, its
// current part, its events, approvals and questions, and nothing else in the host does.
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { historyEntry } from '../parts.js'

const READ_MS = 30_000
const WAIT_DEFAULT_MS = 20_000
const WAIT_MAX_MS = 25_000
const READ_LIMIT = 50
const READ_LIMIT_MAX = 200
const TEXT_MAX = 4_000
const TEXT_CHARS_MAX = 20_000
const CALLER_MAX = 40

const invalid = (message, code = 'bot/invalid') => Object.assign(new Error(message), { code })

export const waitTimeoutMs = (value) => {
  if (value === undefined || value === null) return WAIT_DEFAULT_MS
  const wanted = Math.floor(Number(value))
  if (!Number.isFinite(wanted) || wanted < 0) return WAIT_DEFAULT_MS
  return Math.min(wanted, WAIT_MAX_MS)
}

const seqCursor = (value, fallback) => {
  const wanted = Math.floor(Number(value))
  return Number.isFinite(wanted) ? Math.max(-1, wanted) : fallback
}

export const readLimit = (value) => {
  if (value === undefined || value === null) return READ_LIMIT
  const wanted = Math.floor(Number(value))
  return Number.isFinite(wanted) && wanted > 0 ? Math.min(wanted, READ_LIMIT_MAX) : READ_LIMIT
}

const callerLabel = (caller) => {
  const text = typeof caller === 'string'
    ? Array.from(caller).map(char => (char.codePointAt(0) < 0x20 || char.codePointAt(0) === 0x7f ? ' ' : char)).join('').trim().slice(0, CALLER_MAX)
    : ''
  return text === '' ? 'mcp' : text
}

const approvalDecision = (answer) => {
  const value = typeof answer === 'string' ? answer : answer?.decision ?? answer?.choice
  if (value !== 'allow' && value !== 'reject') throw invalid('Answer an approval with allow or reject')
  return value
}
const questionAnswer = (question, answer) => {
  if (typeof answer === 'string') {
    const labels = (question.options ?? []).map(option => option.label)
    return labels.includes(answer) ? { selected: [answer] } : { custom: answer }
  }
  if (answer === null || typeof answer !== 'object') throw invalid('Answer a question with selected labels or custom text')
  return {
    selected: Array.isArray(answer.selected) ? answer.selected.filter(label => typeof label === 'string') : [],
    custom: typeof answer.custom === 'string' ? answer.custom : '',
  }
}

export function createFacade(rt, { tasks, config = {} } = {}) {
  // The part each Bot's readers saw last, so a move to a fresh part resets the cursor
  // instead of silently skipping the new part's first messages.
  const seenParts = new Map()
  // Answers already given for a requestId, so a replayed post changes nothing.
  const answered = new Map()
  const posting = new Map()

  const load = async () => { await rt.load() }
  const currentPart = bot => rt.chatOf(bot.id)
  const writable = () => {
    const reason = rt.readOnly?.()
    if (reason !== undefined) throw invalid(reason, 'bot/read-only')
  }

  function resolveBot(ref) {
    const wanted = String(ref ?? '').trim()
    if (wanted === '') throw invalid('Name a Bot')
    const bot = rt.findBot?.(wanted) ?? rt.botOf(wanted)
    if (bot !== undefined) return bot
    if (rt.roomOf?.(wanted) !== undefined) throw invalid('Group targets are not supported yet; name one of the group\'s Bots', 'bot/unsupported')
    throw invalid(`Unknown Bot: ${wanted}`, 'bot/not-found')
  }

  function allowedTargets() {
    const configured = Array.isArray(config.targets) ? config.targets.filter(value => typeof value === 'string' && value.trim() !== '') : []
    if (configured.length === 0) return Object.values(rt.state.bots)
    const bots = []
    for (const ref of configured) {
      const bot = rt.findBot?.(ref) ?? rt.botOf(ref)
      if (bot !== undefined && !bots.some(other => other.id === bot.id)) bots.push(bot)
    }
    return bots
  }

  function assertAllowed(bot) {
    const configured = Array.isArray(config.targets) ? config.targets.filter(value => typeof value === 'string' && value.trim() !== '') : []
    if (configured.length === 0) return
    const allowed = configured.some(ref => (rt.findBot?.(ref) ?? rt.botOf(ref))?.id === bot.id)
    if (!allowed) throw invalid(`${bot.name} is not open to outside work`, 'bot/forbidden')
  }

  async function seqOf(part) {
    try {
      const agent = await rt.resolveAgent(part)
      const seq = Number(agent?.session?.seq)
      return Number.isInteger(seq) && seq >= 0 ? seq : 0
    } catch {
      return 0
    }
  }

  const pendingOf = (bot, part) => {
    const approvals = (rt.approvalsView?.() ?? [])
      .filter(entry => entry.botId === bot.id && entry.sessionId === part)
      .map(entry => ({
        kind: 'approval',
        requestId: entry.id,
        tool: entry.tool,
        reason: entry.reason,
        ...(entry.detail ? { detail: entry.detail } : {}),
        at: entry.at,
      }))
    const question = rt.own?.(rt.state.questions ?? {}, part)
    if (question === undefined) return approvals
    return [...approvals, {
      kind: 'question',
      requestId: question.id,
      question: question.question,
      ...(question.detail ? { detail: question.detail } : {}),
      options: (question.options ?? []).map(option => ({ label: option.label, ...(option.description ? { description: option.description } : {}) })),
      multiSelect: question.multiSelect === true,
      allowCustom: question.allowCustom === true,
      at: question.askedAt,
    }]
  }

  const stateOf = (bot, part, pending) => {
    if (rt.botOf(bot.id) === undefined) return 'terminal'
    if (pending.length > 0) return 'waiting_input'
    if (rt.turnsView?.()[part] !== undefined || rt.workView?.()[bot.id] !== undefined) return 'working'
    return 'idle_continuable'
  }

  const requestIdsOf = ref => tasks?.requestIdsFor(ref) ?? new Set()

  // A caller's own posted message is not progress. Its requestId is on the message
  // source (`rpcId`), so read/wait can pass over it while still advancing the cursor.
  const isPosted = (event, requestIds) => event.type === 'user/message'
    && typeof event.data?.source?.rpcId === 'string'
    && requestIds.has(event.data.source.rpcId)

  function lineOf(event) {
    const entry = historyEntry(event)
    if (entry === undefined || entry.text === '') return undefined
    const text = entry.text.length > TEXT_MAX ? `${entry.text.slice(0, TEXT_MAX)}…` : entry.text
    return {
      seq: event.seq,
      time: event.time,
      role: entry.answer ? 'bot' : entry.who === 'user' ? 'user' : 'bot',
      kind: event.type === 'assistant/message' ? 'message' : 'card',
      text,
      ...(text.length === entry.text.length ? {} : { truncated: true }),
    }
  }

  // Events after a seq, oldest first. The Session log is read backwards from its end
  // (the only reader DSH offers) and turned around here; a part is bounded by its
  // checkpoints and the limit keeps a wait answer small.
  async function pageOf(part, afterSeq, limit, requestIds) {
    const collected = []
    try {
      for await (const event of rt.eventsBackwards(part, AbortSignal.timeout(READ_MS), Infinity)) {
        if (event.seq <= afterSeq) break
        collected.push(event)
      }
    } catch (error) {
      if (error?.code?.startsWith?.('bot/')) throw error
      throw invalid('This part is no longer readable', 'bot/unavailable')
    }
    collected.reverse()
    const events = []
    let cursor = afterSeq
    let hasMore = false
    for (const event of collected) {
      if (events.length >= limit) {
        hasMore = true
        break
      }
      cursor = Math.max(cursor, Number(event.seq) || 0)
      if (isPosted(event, requestIds)) continue
      const line = lineOf(event)
      if (line !== undefined) events.push(line)
    }
    return { events, cursor, hasMore }
  }

  const priorPart = botId => seenParts.get(botId) ?? tasks?.latestPart(botId)
  const remember = async (bot, part, state, pending) => {
    seenParts.set(bot.id, part)
    await tasks?.updateForRef(bot.id, {
      partSessionId: part,
      state,
      pending: pending.length === 0 ? null : { kind: pending[0].kind, requestId: pending[0].requestId },
    })
  }

  const targetView = bot => ({
    id: bot.id,
    name: bot.name,
    role: bot.role ?? '',
    model: bot.appliedModel ?? bot.model ?? null,
    permission: bot.permission ?? rt.permissionCatalog?.()?.defaultPreset ?? null,
  })

  async function targets() {
    await load()
    return { targets: allowedTargets().map(targetView) }
  }

  function ack(task) {
    return {
      taskId: task.id,
      ref: task.ref,
      partSessionId: task.partSessionId,
      afterSeq: task.sinceSeq,
      state: task.state ?? 'posted',
    }
  }

  async function post(ref, text, { freshPart = false, requestId, caller } = {}) {
    await load()
    writable()
    const bot = resolveBot(ref)
    assertAllowed(bot)
    const body = String(text ?? '').trim()
    if (body === '') throw invalid('A post needs text')
    if (body.length > TEXT_CHARS_MAX) throw invalid(`A post can carry at most ${TEXT_CHARS_MAX} characters`)
    const rid = typeof requestId === 'string' && requestId.trim() !== '' ? requestId.trim().slice(0, 200) : randomUUID()
    const known = tasks?.findByRequest(rid) ?? answered.get(rid)
    if (known !== undefined) {
      if (known.ref !== bot.id) throw invalid('That requestId was used for another Bot')
      return ack(known)
    }
    if (posting.has(rid)) return posting.get(rid)
    const run = sendPost({ bot, body, rid, freshPart, caller }).finally(() => posting.delete(rid))
    posting.set(rid, run)
    return run
  }

  async function sendPost({ bot, body, rid, freshPart, caller }) {
    const part = currentPart(bot)
    if (part === undefined) throw invalid('This Bot has no chat part', 'bot/unavailable')
    const sinceSeq = Math.max(-1, (await seqOf(part)) - 1)
    const task = {
      id: randomUUID(),
      ref: bot.id,
      requestId: rid,
      caller: callerLabel(caller),
      partSessionId: part,
      sinceSeq,
      state: 'posted',
      pending: null,
      terminal: false,
      ...(freshPart ? { freshPart: true } : {}),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    await tasks?.add(task)
    try {
      // A fresh part takes the message along: parts.js moves what waits in the old
      // part's inbox into the part it opens.
      if (freshPart) await rt.newPart(currentPart(bot))
      await rt.sendUser({
        sessionId: bot.id,
        content: [{ type: 'text', text: `[inbox: ${task.caller} · task ${task.id}]\n${body}` }],
        requestId: rid,
      })
    } catch (error) {
      await tasks?.remove(task.id).catch(() => {})
      throw error
    }
    answered.set(rid, task)
    await tasks?.update(task.id, { state: 'posted' })
    return ack(task)
  }

  async function read(ref, { afterSeq, limit } = {}) {
    await load()
    const bot = resolveBot(ref)
    const part = currentPart(bot)
    if (part === undefined) throw invalid('This Bot has no chat part', 'bot/unavailable')
    const prior = priorPart(bot.id)
    const reset = prior !== undefined && prior !== part
    const cursor = reset ? -1 : seqCursor(afterSeq, -1)
    const page = await pageOf(part, cursor, readLimit(limit), requestIdsOf(bot.id))
    const pending = pendingOf(bot, part)
    const state = stateOf(bot, part, pending)
    await remember(bot, part, state, pending)
    return {
      ref: bot.id,
      partSessionId: part,
      ...(reset ? { reset: true } : {}),
      afterSeq: page.cursor,
      events: page.events,
      hasMore: page.hasMore,
      pending,
      state,
    }
  }

  async function wait(ref, { afterSeq, timeoutMs } = {}) {
    await load()
    const bot = resolveBot(ref)
    const timeout = waitTimeoutMs(timeoutMs)
    const started = Date.now()
    const deadline = started + timeout
    let part = currentPart(bot)
    if (part === undefined) throw invalid('This Bot has no chat part', 'bot/unavailable')
    let reset = false
    let cursor
    if (afterSeq === undefined || afterSeq === null) cursor = Math.max(-1, (await seqOf(part)) - 1)
    else {
      const prior = priorPart(bot.id)
      reset = prior !== undefined && prior !== part
      cursor = reset ? -1 : seqCursor(afterSeq, -1)
    }
    let working = rt.turnsView?.()[part] !== undefined || rt.workView?.()[bot.id] !== undefined
    for (;;) {
      const current = currentPart(bot)
      if (current !== undefined && current !== part) {
        part = current
        cursor = -1
        reset = true
      }
      const page = await pageOf(part, cursor, readLimit(20), requestIdsOf(bot.id))
      const pending = pendingOf(bot, part)
      const state = stateOf(bot, part, pending)
      const progressed = reset || page.events.length > 0 || pending.length > 0 || (working && state !== 'working')
      if (progressed || Date.now() >= deadline) {
        await remember(bot, part, state, pending)
        return {
          ref: bot.id,
          partSessionId: part,
          ...(reset ? { reset: true } : {}),
          afterSeq: page.cursor,
          events: page.events,
          hasMore: page.hasMore,
          pending,
          state,
          waitedMs: Math.min(timeout, Math.max(0, Date.now() - started)),
        }
      }
      working ||= state === 'working'
      await delay(Math.min(400, Math.max(0, deadline - Date.now())))
    }
  }

  async function answer(ref, requestId, value) {
    await load()
    writable()
    const bot = resolveBot(ref)
    assertAllowed(bot)
    const id = String(requestId ?? '')
    if (id === '') throw invalid('Name the requestId to answer')
    const approval = (rt.approvalsView?.() ?? []).find(entry => entry.id === id && entry.botId === bot.id)
    if (approval !== undefined) {
      const decision = approvalDecision(value)
      rt.answerApproval(id, decision)
      await tasks?.updateForRef(bot.id, { pending: null, state: 'working' })
      return { kind: 'approval', requestId: id, answered: decision }
    }
    const part = currentPart(bot)
    const question = part === undefined ? undefined : rt.own?.(rt.state.questions ?? {}, part)
    if (question !== undefined && question.id === id) {
      await rt.answerQuestion(bot.id, id, questionAnswer(question, value))
      await tasks?.updateForRef(bot.id, { pending: null, state: 'working' })
      return { kind: 'question', requestId: id, answered: true }
    }
    throw invalid('No approval or question with that requestId is open', 'bot/stale')
  }

  async function stop(ref) {
    await load()
    writable()
    const bot = resolveBot(ref)
    assertAllowed(bot)
    const stopped = await rt.stopChat(bot.id)
    await tasks?.markTerminalFor(bot.id)
    return { ref: bot.id, stopped: stopped === true }
  }

  return { targets, post, read, wait, answer, stop }
}
