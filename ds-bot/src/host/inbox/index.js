// The Bot inbox: an MCP endpoint on the profile's web server lets a caller post a task to
// one of this host's Bots, read its progress, answer its approval or question, and stop
// it. The caller reaches a Bot's own chat, not a hidden Session: the Bot works with its
// ordinary tools, memory and permission preset.
import { createFacade } from './facade.js'
import * as mcp from './mcp.js'
import { createTasks } from './tasks.js'

export function install(rt) {
  const config = rt.config?.inbox ?? {}
  const tasks = createTasks({ home: rt.home, warn: rt.warn })
  const facade = createFacade(rt, { tasks, config })
  mcp.install(rt, { facade, config, warn: rt.warn })
}
