import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BridgeSnapshot } from './bridge.js'
import { BoardError, type JiraBoard, type ToolBridge } from './board.js'

export const ROUTE_PREFIX = '/plugins/atlassian'
export interface RouteRegistrar { register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void }
export interface RequestFence { requestRejection(req: IncomingMessage): number | undefined }
export interface BoardRouteOptions { jql: string; limit: number; timeoutMs: number; promptTemplate: string }
export interface EditableConnection {
  snapshot(): { jiraUrl: string; confluenceUrl: string; jiraCaFile: string; confluenceCaFile: string; allowInsecureHttp: boolean }
  update(input: Record<string, unknown>): Promise<void>
}
export interface PluginBridge extends ToolBridge {
  snapshot(): BridgeSnapshot
  rawNames(): readonly string[]
  authorize(input?: Record<string, unknown>): Promise<BridgeSnapshot>
  disconnect(): Promise<BridgeSnapshot>
  start(): Promise<void>
  dispose(): Promise<void>
}

function respond(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += data.length
    if (size > 65536) throw new BoardError('too-large', 'Request body is too large')
    chunks.push(data)
  }
  if (!size) return {}
  let value: unknown
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new BoardError('bad-request', 'Invalid JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BoardError('bad-request', 'Request body must be an object')
  return value as Record<string, unknown>
}
function required(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string' || !value.trim()) throw new BoardError('bad-request', `Missing ${key}`)
  return value
}

export function registerRoutes(web: RouteRegistrar, bridge: PluginBridge, board: JiraBoard, options: BoardRouteOptions, fence: RequestFence | undefined, connection?: EditableConnection): () => void {
  return web.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: async (req, res) => {
    if (!fence) { respond(res, 503, { ok: false, error: 'DSH connection service is unavailable' }); return }
    const rejection = fence.requestRejection(req)
    if (rejection !== undefined) { res.writeHead(rejection).end(); return }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const action = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\//, '')
    const method = req.method ?? 'GET'
    try {
      if (method === 'GET' && action === 'status') {
        respond(res, 200, { ...bridge.snapshot(), ok: true, board: { jql: options.jql, limit: options.limit, promptTemplate: options.promptTemplate }, ...(connection ? { configuration: connection.snapshot() } : {}) }); return
      }
      if (method === 'POST' && action === 'configure') {
        if (!connection) { respond(res, 503, { ok: false, error: 'Connection settings are unavailable' }); return }
        await connection.update(await readBody(req))
        respond(res, 200, { ok: true }); return
      }
      if (method === 'POST' && action === 'connect') {
        const input = bridge.snapshot().mode === 'server' ? await readBody(req) : undefined
        respond(res, 200, { ...await bridge.authorize(input), ok: true }); return
      }
      if (method === 'POST' && action === 'disconnect') { respond(res, 200, { ...await bridge.disconnect(), ok: true }); return }
      if (method === 'GET' && action === 'debug-tools') { respond(res, 200, { ok: true, names: bridge.rawNames() }); return }
      if (method === 'GET' && action === 'board') {
        const result = await board.load({ jql: url.searchParams.get('jql') ?? options.jql, limit: options.limit, timeoutMs: options.timeoutMs })
        respond(res, 200, { ok: true, ...result }); return
      }
      if (method === 'GET' && action === 'projects') { respond(res, 200, { ok: true, projects: await board.projects(options.timeoutMs) }); return }
      if (method === 'POST' && action === 'transition') {
        const input = await readBody(req)
        await board.transition(required(input, 'key'), required(input, 'transitionId'), options.timeoutMs)
        respond(res, 200, { ok: true }); return
      }
      const match = /^issue\/([^/]+)(\/transitions)?$/.exec(action)
      if (method === 'GET' && match) {
        const key = decodeURIComponent(match[1] ?? '')
        if (match[2]) respond(res, 200, { ok: true, transitions: await board.transitions(key, options.timeoutMs) })
        else respond(res, 200, { ok: true, ...await board.detail(key, options.timeoutMs) })
        return
      }
      respond(res, 404, { ok: false, error: 'unknown endpoint' })
    } catch (error) {
      respond(res, error instanceof BoardError ? 400 : 500, { ok: false, ...(error instanceof BoardError ? { code: error.code } : {}), error: error instanceof Error ? error.message : String(error) })
    }
  } })
}
