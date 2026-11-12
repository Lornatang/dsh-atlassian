import type { Context } from '@deepseek-ai/cordis'
import { AtlassianBridge } from './bridge.js'
import { ServerBridge } from './server-bridge.js'
import { createBoard } from './board.js'
import { Config, configureEndpoints, type Config as Settings } from './config.js'
import { registerRoutes, type EditableConnection, type PluginBridge, type RequestFence, type RouteRegistrar } from './routes.js'
import { SessionStore, sessionFileFor } from './store.js'

export const name = 'atlassian'
export const inject = ['tools']
export { Config }

interface Scope {
  get(name: string): unknown
  profileContext?: { patchPath?: string }
  on?(event: string, callback: () => void): (() => void) | undefined
}

interface ConfigEditor {
  entries(): Array<{ options: { id: string } }>
  edit(entry: { options: { id: string } }, change: (current: unknown, inherited: unknown) => unknown): Promise<void>
}

export function apply(ctx: Context, config: Settings): void {
  const scope = ctx as unknown as Scope
  const identity = config.mode === 'server' ? `server:${config.server.jiraUrl}\0${config.server.confluenceUrl}` : config.url
  const store = new SessionStore(sessionFileFor(config.serverName, identity, scope.profileContext?.patchPath))
  const host = { register: (definition: Parameters<typeof ctx.tools.register>[0]) => ctx.tools.register(definition), logger: ctx.logger }
  const bridge: PluginBridge = config.mode === 'server'
    ? new ServerBridge(host, { serverName: config.serverName, server: config.server, store, timeoutMs: config.toolCallTimeoutMs })
    : new AtlassianBridge(host, { serverName: config.serverName, url: config.url, redirectPort: config.redirectPort, toolCallTimeoutMs: config.toolCallTimeoutMs, expectedSite: config.expectedSite, authorizationTimeoutMs: config.authorizationTimeoutMs, autoOpenBrowser: config.autoOpenBrowser, store })
  const board = createBoard(bridge)
  const connection: EditableConnection = {
    snapshot: () => ({ ...config.server }),
    update: async (input) => {
      configureEndpoints(config, input)
      const editor = scope.get('configEditor') as ConfigEditor | undefined
      const entry = editor?.entries().find((candidate) => candidate.options.id === 'atlassian')
      if (!editor || !entry) throw new Error('DSH configuration editor is unavailable')
      await editor.edit(entry, (current) => configureEndpoints(Config(current as Parameters<typeof Config>[0]), input))
    },
  }
  ctx.effect(() => () => bridge.dispose(), 'atlassian:connection')
  ctx.effect(() => {
    let dispose: (() => void) | undefined
    let secured = false
    const bind = (): void => {
      const web = (scope.get('webServer') ?? scope.get('httpServer')) as RouteRegistrar | undefined
      if (!web) return
      const fence = scope.get('connection') as RequestFence | undefined
      if (dispose && (secured || !fence)) return
      dispose?.()
      dispose = registerRoutes(web, bridge, board, config.board, fence, connection)
      secured = !!fence
    }
    bind()
    const off = scope.on?.('internal/service', bind)
    return () => { off?.(); dispose?.() }
  }, 'atlassian:routes')
  void bridge.start().catch((error: unknown) => ctx.logger.error(`atlassian: ${String(error)}`))
}
