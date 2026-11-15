import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError, auth } from '@modelcontextprotocol/sdk/client/auth.js'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { AtlassianOAuthProvider, CallbackServer, createCloudFetch, secureUrl, type Logger } from './oauth.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { openInBrowser } from './open-url.js'
import type { SessionStore } from './store.js'

export interface BridgeHost { register(definition: ToolDefinition): () => void; logger: Logger }
export interface BridgeOptions {
  serverName: string; url: string; redirectPort: number; toolCallTimeoutMs: number
  expectedSite: string; authorizationTimeoutMs: number; autoOpenBrowser: boolean; store: SessionStore
}
export type BridgeStatus = 'idle' | 'connecting' | 'authorizing' | 'ready' | 'error'
export interface BridgeSnapshot {
  status: BridgeStatus; authorizationUrl: string | undefined; site: string | undefined
  siteMismatch: boolean; toolCount: number; error: string | undefined; mode?: 'cloud' | 'server'
  server?: { jiraUrl: string; confluenceUrl: string; hasJiraCredential: boolean; hasConfluenceCredential: boolean; allowInsecureHttp: boolean }
}
interface OperationContext {
  generation: number
  signal: AbortSignal
  observedTokens?: OAuthTokens
  refreshExpected?: OAuthTokens
  releaseRefresh?: () => void
}

async function waitForFlight(flight: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error('atlassian: connection cancelled')
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => { signal.removeEventListener('abort', abort); reject(new Error('atlassian: connection cancelled')) }
    signal.addEventListener('abort', abort, { once: true })
    void flight.then(() => { signal.removeEventListener('abort', abort); resolve() }, reject)
    if (signal.aborted) abort()
  })
}

export function publicToolName(server: string, tool: string): string {
  const raw = `mcp__${server}__${tool}`
  const clean = raw.replace(/[^A-Za-z0-9_-]/g, '_')
  if (raw === clean && clean.length <= 64) return clean
  const suffix = createHash('sha256').update(`${server}\0${tool}`).digest('hex').slice(0, 12)
  return `${clean.slice(0, 51)}_${suffix}`
}

function display(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.map((part: unknown) => {
    if (!part || typeof part !== 'object') return ''
    const block = part as Record<string, unknown>
    return block['type'] === 'text' && typeof block['text'] === 'string' ? block['text'] : `[${String(block['type'] ?? 'unknown')} content]`
  }).filter(Boolean).join('\n\n')
}

export class AtlassianBridge {
  readonly #host: BridgeHost
  readonly #options: BridgeOptions
  readonly #callback = new CallbackServer()
  readonly #operation = new AsyncLocalStorage<OperationContext>()
  readonly #provider: AtlassianOAuthProvider
  readonly #fetch: FetchLike
  #client?: Client
  #tools = new Map<string, { raw: string; dispose: () => void }>()
  #status: BridgeStatus = 'idle'
  #url?: string
  #error?: string
  #work?: Promise<void>
  #boot?: Promise<void>
  #generation = 0
  #disposed = false
  #controller = new AbortController()
  #flight?: { owner: OperationContext; done: Promise<void> }

  constructor(host: BridgeHost, options: BridgeOptions) {
    this.#host = host
    this.#options = options
    const network = createCloudFetch(new URL(options.url))
    const active = (): boolean => {
      const operation = this.#operation.getStore()
      return !this.#disposed && (!operation || (operation.generation === this.#generation && !operation.signal.aborted))
    }
    this.#fetch = async (value, init) => {
      const operation = this.#operation.getStore()
      if (!operation) return network.fetch(value, init)
      if (!active()) throw new Error('atlassian: connection cancelled')
      const signals = [operation.signal]
      if (init?.signal) signals.push(init.signal)
      const signal = AbortSignal.any(signals)
      const authorization = new Headers(init?.headers).get('authorization')
      if (authorization?.startsWith('Bearer ')) {
        const current = this.#options.store.current.tokens
        const previous = operation.observedTokens
        operation.observedTokens = previous && authorization === `Bearer ${previous.access_token}` ? previous
          : current && authorization === `Bearer ${current.access_token}` ? current : undefined
      }
      const refresh = init?.body instanceof URLSearchParams && init.body.get('grant_type') === 'refresh_token'
      if (!refresh) return network.fetch(value, { ...init, signal })
      // A synthetic response must obey the same URL policy as a network request.
      secureUrl(new URL(value), network.allowLoopbackHttp)
      const expected = operation.observedTokens
      while (this.#flight && this.#flight.owner !== operation) await waitForFlight(this.#flight.done, signal)
      if (!active() || signal.aborted) throw new Error('atlassian: connection cancelled')
      operation.refreshExpected = expected
      const current = this.#options.store.current.tokens
      if (expected && current !== expected) {
        return new Response(JSON.stringify(current ?? { error: 'invalid_grant' }), { status: current ? 200 : 400, headers: { 'content-type': 'application/json' } })
      }
      if (!this.#flight) {
        let complete!: () => void
        const done = new Promise<void>((resolve) => { complete = resolve })
        const release = (): void => {
          if (this.#flight?.owner === operation) { this.#flight = undefined; signal.removeEventListener('abort', release); complete() }
          if (operation.releaseRefresh === release) operation.releaseRefresh = undefined
        }
        this.#flight = { owner: operation, done }
        operation.releaseRefresh = release
        signal.addEventListener('abort', release, { once: true })
        if (signal.aborted) release()
      }
      try { return await network.fetch(value, { ...init, signal }) }
      catch (error) { operation.releaseRefresh?.(); throw error }
    }
    this.#provider = new AtlassianOAuthProvider({
      store: options.store, redirectUri: () => this.#callback.redirectUri, allowLoopbackHttp: network.allowLoopbackHttp, logger: host.logger,
      onAuthorizationUrl: (url) => {
        if (!active()) return
        this.#url = url
        if (this.#status === 'ready') { this.#status = 'error'; this.#error = 'Atlassian authorization expired; reconnect to authorize again' }
      },
      active,
      tokenRead: (tokens) => { const op = this.#operation.getStore(); if (op && !op.observedTokens) op.observedTokens = tokens },
      refreshExpected: () => this.#operation.getStore()?.refreshExpected,
      authFinished: () => { const op = this.#operation.getStore(); op?.releaseRefresh?.(); if (op) op.refreshExpected = undefined },
    })
  }

  #newOperation(): OperationContext { return { generation: this.#generation, signal: this.#controller.signal } }

  snapshot(): BridgeSnapshot {
    const site = this.#options.store.current.site
    let mismatch = false
    if (site && this.#options.expectedSite.trim()) {
      try {
        const raw = this.#options.expectedSite.trim()
        mismatch = new URL(raw.includes('://') ? raw : `https://${raw}`).host.toLowerCase() !== site.toLowerCase()
      } catch { mismatch = true }
    }
    return { status: this.#status, authorizationUrl: this.#url, site, siteMismatch: mismatch, toolCount: this.#tools.size, error: this.#error }
  }
  rawNames(): readonly string[] { return [...this.#tools.values()].map((value) => value.raw) }
  rawNameMatching(pattern: RegExp): string | undefined { return this.rawNames().find((name) => pattern.test(name)) }

  async start(): Promise<void> {
    if (this.#boot) return this.#boot
    const generation = this.#generation
    const boot = (async () => {
      this.#status = 'connecting'
      await this.#options.store.load()
      if (this.#disposed || generation !== this.#generation) return
      await this.#callback.listen(this.#options.redirectPort)
      if (this.#disposed || generation !== this.#generation) return
      const previous = this.#options.store.current.redirectUri
      const actual = this.#callback.redirectUri
      if (previous && previous !== actual) await this.#options.store.clear('clientInformation', 'tokens', 'codeVerifier')
      await this.#options.store.patch({ redirectUri: actual })
      if (this.#disposed || generation !== this.#generation) return
      this.#launch(false, generation)
      for (let i = 0; i < 600 && this.#status === 'connecting'; i++) await delay(25)
    })()
    this.#boot = boot
    try { await boot } catch (error) {
      if (!this.#disposed && generation === this.#generation) {
        this.#status = 'error'
        this.#error = error instanceof Error ? error.message : String(error)
      }
      throw error
    } finally { if (this.#boot === boot) this.#boot = undefined }
  }

  async authorize(): Promise<BridgeSnapshot> {
    await this.#boot
    if (this.#disposed || this.#status === 'ready') return this.snapshot()
    if (this.#status === 'authorizing' && this.#url) {
      if (this.#options.autoOpenBrowser) await openInBrowser(this.#url)
      return this.snapshot()
    }
    if (!this.#work) {
      await this.#closeClient()
      this.#clearTools()
      this.#url = undefined
      this.#launch(true, this.#generation)
    }
    for (let i = 0; i < 800 && this.#status === 'connecting' && !this.#url; i++) await delay(25)
    return this.snapshot()
  }

  #launch(open: boolean, generation: number): void {
    const work = this.#connect(open, generation).catch((error: unknown) => {
      if (!this.#disposed && generation === this.#generation) {
        this.#status = 'error'
        this.#error = error instanceof Error ? error.message : String(error)
        this.#host.logger.error(`atlassian: ${this.#error}`)
      }
    })
    this.#work = work
    void work.finally(() => { if (this.#work === work) this.#work = undefined })
  }

  async #connect(open: boolean, generation: number): Promise<void> {
    const check = (): void => { if (this.#disposed || generation !== this.#generation) throw new Error('connection cancelled') }
    for (let attempt = 0; attempt < 2; attempt++) {
      check()
      this.#status = 'connecting'
      this.#error = undefined
      const client = new Client({ name: 'dsh-atlassian', version: '0.1.8' })
      client.onerror = () => { this.#operation.getStore()?.releaseRefresh?.() }
      const transport = new StreamableHTTPClientTransport(new URL(this.#options.url), { authProvider: this.#provider, fetch: this.#fetch })
      const send = transport.send.bind(transport)
      transport.send = (message, options) => {
        const operation = this.#newOperation()
        return this.#operation.run(operation, async () => {
          try { return await send(message, options) } catch (error) { operation.releaseRefresh?.(); throw error }
        })
      }
      try { await client.connect(transport); check() }
      catch (error) {
        await transport.close().catch(() => undefined)
        check()
        if (!(error instanceof UnauthorizedError) || attempt !== 0) throw error
        const state = this.#url ? new URL(this.#url).searchParams.get('state') ?? undefined : undefined
        const waiting = this.#callback.waitForCode(this.#options.authorizationTimeoutMs, state)
        this.#status = 'authorizing'
        if (open && this.#url && this.#options.autoOpenBrowser) void openInBrowser(this.#url)
        const callback = await waiting
        check()
        await this.#operation.run(this.#newOperation(), () => auth(this.#provider, { serverUrl: this.#options.url, authorizationCode: callback.code, fetchFn: this.#fetch }))
        check()
        await this.#options.store.clear('codeVerifier')
        continue
      }
      this.#client = client
      await this.#registerTools(client)
      check()
      await this.#readSite(client)
      check()
      this.#url = undefined
      this.#status = 'ready'
      return
    }
    throw new Error('Atlassian authorization did not establish a connection')
  }

  async #registerTools(client: Client): Promise<void> {
    const found: Array<{ name: string; description?: string; inputSchema: unknown }> = []
    const seen = new Set<string>()
    let cursor: string | undefined
    do {
      if (seen.size >= 100) throw new Error('MCP server returned too many tool pages')
      const page = await client.listTools(cursor ? { cursor } : {})
      found.push(...page.tools)
      if (found.length > 1000) throw new Error('MCP server returned too many tools')
      cursor = page.nextCursor
      if (cursor && seen.has(cursor)) throw new Error('MCP server repeated a continuation cursor')
      if (cursor) seen.add(cursor)
    } while (cursor)
    const names = new Set<string>()
    for (const tool of found) {
      const name = publicToolName(this.#options.serverName, tool.name)
      if (names.has(name)) throw new Error('MCP server returned duplicate tool names')
      names.add(name)
    }
    this.#clearTools()
    try {
      for (const tool of found) {
        const name = publicToolName(this.#options.serverName, tool.name)
        const definition = {
          name, description: tool.description ?? '', parameters: tool.inputSchema,
          output: {
            schema: { type: 'object', properties: { content: { type: 'array', items: {} } }, required: ['content'], additionalProperties: false },
            render: (_args: unknown, result: unknown) => [{ type: 'text', text: display((result as { content?: unknown })?.content) }],
          },
          execute: async (args: unknown, context: { signal?: AbortSignal }) => {
            const result = await client.callTool({ name: tool.name, arguments: (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown> }, undefined, { timeout: this.#options.toolCallTimeoutMs, signal: context.signal })
            if (result.isError) throw new Error(display(result.content))
            return { content: result.content }
          },
        } as ToolDefinition
        this.#tools.set(name, { raw: tool.name, dispose: this.#host.register(definition) })
      }
    } catch (error) { this.#clearTools(); throw error }
  }

  async #readSite(client: Client): Promise<void> {
    const name = this.rawNameMatching(/accessibleatlassianresources/i)
    if (!name) return
    try {
      const result = await client.callTool({ name, arguments: {} }, undefined, { timeout: 20000 })
      const items: unknown = JSON.parse(display(result.content))
      const first = Array.isArray(items) ? items[0] : items
      if (first && typeof first === 'object' && typeof (first as Record<string, unknown>)['url'] === 'string') {
        await this.#options.store.patch({ site: new URL((first as Record<string, string>)['url']!).host })
      }
    } catch { /* The connection can work without a site label. */ }
  }

  async callTool(rawName: string, args: Record<string, unknown>, timeoutMs?: number): Promise<readonly unknown[]> {
    if (!this.#client || this.#status !== 'ready') throw new Error('Atlassian is not connected')
    const result = await this.#client.callTool({ name: rawName, arguments: args }, undefined, { timeout: timeoutMs ?? this.#options.toolCallTimeoutMs })
    if (result.isError) throw new Error(display(result.content))
    return Array.isArray(result.content) ? result.content : []
  }

  async disconnect(): Promise<BridgeSnapshot> {
    this.#generation++
    this.#controller.abort()
    this.#controller = new AbortController()
    this.#status = 'idle'
    this.#callback.cancelWait()
    await this.#boot?.catch(() => undefined)
    this.#callback.cancelWait()
    await this.#work
    await this.#closeClient()
    this.#clearTools()
    await this.#options.store.destroy()
    this.#url = undefined
    this.#error = undefined
    return this.snapshot()
  }
  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#generation++
    this.#controller.abort()
    this.#status = 'idle'
    this.#callback.cancelWait()
    await this.#boot?.catch(() => undefined)
    this.#callback.cancelWait()
    await this.#work
    await this.#closeClient()
    this.#clearTools()
    await this.#callback.close()
  }
  async #closeClient(): Promise<void> {
    const client = this.#client
    this.#client = undefined
    await client?.close().catch(() => undefined)
  }
  #clearTools(): void {
    for (const value of this.#tools.values()) value.dispose()
    this.#tools.clear()
  }
}
