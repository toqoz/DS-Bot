// Task records for the Bot inbox: what an outside caller asked this host's Bots to do, and how far
// the caller has read. They live beside the team, never inside state.json: DS Bot's store
// is the single writer of the team, and a second writer there would fight its lock.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { replaceFile } from '../files.js'

const VERSION = 1
const KEPT = 500
const TERMINAL_KEPT_MS = 7 * 24 * 60 * 60 * 1000

// A task is one accepted `post`. `sinceSeq` is the Session seq the caller started from,
// so a replayed `post` answers with the same cursor. `partSessionId` follows the Bot's
// current part; `state` and `pending` are the last observation, refreshed by read/wait.
export function createTasks({ home, warn = () => {} }) {
  const dir = join(home, 'inbox')
  const path = join(dir, 'tasks.json')
  /** @type {any[]} */
  let tasks = []
  let loaded
  let writing = Promise.resolve()

  const load = () => loaded ??= (async () => {
    let text
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return
      warn('ds-bot: inbox tasks not read: %s', error)
      return
    }
    try {
      const saved = JSON.parse(text)
      if (Array.isArray(saved?.tasks)) tasks = saved.tasks.filter(task => task !== null && typeof task === 'object')
    } catch (error) {
      warn('ds-bot: inbox tasks are not readable JSON; starting with none: %s', error)
    }
  })()

  const write = async () => {
    await mkdir(dir, { recursive: true })
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify({ version: VERSION, tasks }, null, 2))
    await replaceFile(temp, path)
  }

  const flush = () => {
    const run = writing.then(write)
    writing = run.catch(error => warn('ds-bot: inbox tasks not saved: %s', error))
    return run
  }

  const prune = () => {
    const now = Date.now()
    tasks = tasks.filter(task => task.terminal !== true || now - (task.updatedAt ?? task.createdAt ?? now) < TERMINAL_KEPT_MS)
    if (tasks.length <= KEPT) return
    const keep = new Set([...tasks].sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0)).slice(0, KEPT))
    tasks = tasks.filter(task => keep.has(task))
  }

  const all = () => tasks
  const findByRequest = requestId => tasks.find(task => task.requestId === requestId)
  const latestPart = ref => {
    let part
    for (const task of tasks) if (task.ref === ref && typeof task.partSessionId === 'string') part = task.partSessionId
    return part
  }
  const requestIdsFor = ref => new Set(tasks
    .filter(task => task.ref === ref && task.terminal !== true && typeof task.requestId === 'string')
    .map(task => task.requestId))

  async function add(task) {
    await load()
    prune()
    tasks.push(task)
    await flush()
  }

  async function remove(id) {
    await load()
    const at = tasks.findIndex(task => task.id === id)
    if (at === -1) return
    tasks.splice(at, 1)
    await flush()
  }

  // One task's fields as read/wait last saw them; the file changes only when they did.
  async function update(id, patch) {
    await load()
    const task = tasks.find(entry => entry.id === id)
    if (task === undefined) return
    if (Object.entries(patch).every(([key, value]) => JSON.stringify(task[key]) === JSON.stringify(value))) return
    Object.assign(task, patch, { updatedAt: Date.now() })
    await flush()
  }

  // Every open task for a Bot follows the same current part and pending item: a caller
  // that reconnects can read the record without naming a task.
  async function updateForRef(ref, patch) {
    await load()
    let changed = false
    for (const task of tasks) {
      if (task.ref !== ref || task.terminal === true) continue
      if (Object.entries(patch).every(([key, value]) => JSON.stringify(task[key]) === JSON.stringify(value))) continue
      Object.assign(task, patch, { updatedAt: Date.now() })
      changed = true
    }
    if (changed) await flush()
  }

  async function markTerminalFor(ref) {
    await load()
    let changed = false
    for (const task of tasks) {
      if (task.ref !== ref || task.terminal === true) continue
      Object.assign(task, { state: 'terminal', pending: null, terminal: true, updatedAt: Date.now() })
      changed = true
    }
    if (changed) await flush()
  }

  return { load, all, findByRequest, latestPart, requestIdsFor, add, remove, update, updateForRef, markTerminalFor }
}
