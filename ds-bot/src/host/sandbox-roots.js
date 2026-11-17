// Extra writable folders per Bot: the policy service asks this module which folders
// belong to the Session's Bot, and the sandbox grants them alongside the Session's cwd.
// The DSH service is optional so the plugin still loads on a DSH without the provider.
import { realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

export function install(rt) {
  const { ctx } = rt

  // The enforcing host rejects a missing folder, a file, or a symlinked root. A folder
  // can go away after it was saved, so answer with only the roots that still qualify
  // instead of failing every confined call in the Bot.
  const usable = (root) => {
    try {
      const physical = realpathSync.native(root)
      return physical === resolve(root) && statSync(physical).isDirectory()
    } catch {
      return false
    }
  }

  // The settings card is only useful where the policy service can take the grants.
  rt.writableRootsSupported = () => typeof ctx.get?.('sandboxPolicy')?.registerWritableRootsProvider === 'function'

  rt.writableRootsOf = (session) => {
    const botId = session === undefined ? undefined : rt.selfOf?.(session.id)
    const roots = botId === undefined ? undefined : rt.botOf(botId)?.writableRoots
    if (roots === undefined) return undefined
    const found = roots.filter(usable)
    return found.length > 0 ? found : undefined
  }

  ctx.inject?.(['sandboxPolicy'], (scope) => {
    const service = scope.sandboxPolicy
    if (service === undefined || typeof service.registerWritableRootsProvider !== 'function') return
    scope.effect(() => service.registerWritableRootsProvider({
      rootsFor: ({ session }) => (session === undefined ? undefined : rt.writableRootsOf(session)),
    }), 'ds-bot: per-Bot writable roots')
  })
}
