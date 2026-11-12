import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { BridgeHost, BridgeSnapshot } from './bridge.js'
import { publicToolName } from './bridge.js'
import type { ServerConfig } from './config.js'
import { ServerHttp } from './server-http.js'
import { SessionStore, type ServerCredential, type ServerCredentials } from './store.js'

type Args = Record<string, unknown>
type Schema = Record<string, unknown>
interface Operation {
  description: string
  properties: Record<string, Schema>
  required?: string[]
  execute: (args: Args, signal?: AbortSignal, timeoutMs?: number) => Promise<unknown>
}
const string = { type: 'string' }
const integer = { type: 'integer' }
const object = { type: 'object', additionalProperties: true }
const strings = { type: 'array', items: { type: 'string' } }

function text(args: Args, name: string): string {
  const value = args[name]
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Missing field ${name}`)
  return value
}
function key(args: Args, name: string, pattern = /^[A-Za-z0-9_-]+$/): string {
  const value = text(args, name)
  if (!pattern.test(value) || value.length > 128) throw new Error(`Invalid field ${name}`)
  return value
}
function limit(value: unknown, fallback: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? Math.max(1, Math.min(max, value)) : fallback
}
function offset(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) ? Math.max(0, value) : 0
}
function record(value: unknown, label: string): Args {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Args
}
function credential(input: Args, product: 'jira' | 'confluence', previous?: ServerCredential): ServerCredential | undefined {
  const secret = input[`${product}Secret`]
  const username = input[`${product}Username`]
  if (secret === undefined || secret === '') {
    if (typeof username === 'string' && username.trim() && username.trim() !== previous?.username) {
      throw new Error(`Enter a password when changing the ${product} username`)
    }
    return previous
  }
  if (typeof secret !== 'string' || (username !== undefined && typeof username !== 'string')) throw new Error(`${product} credentials are invalid`)
  return { secret, ...(typeof username === 'string' && username.trim() ? { username: username.trim() } : {}) }
}

/** Direct REST bridge for older Jira Server and Confluence Server/Data Center. */
export class ServerBridge {
  readonly #host: BridgeHost
  readonly #config: ServerConfig
  readonly #name: string
  readonly #store: SessionStore
  readonly #timeout: number
  #credentials: ServerCredentials = {}
  #operations = new Map<string, Operation>()
  #disposers: Array<() => void> = []
  #controllers = new Set<AbortController>()
  #status: BridgeSnapshot['status'] = 'idle'
  #error: string | undefined
  #disposed = false
  #generation = 0
  #starting: Promise<void> | undefined
  #running: Promise<void> | undefined

  constructor(host: BridgeHost, options: { serverName: string; server: ServerConfig; store: SessionStore; timeoutMs: number }) {
    this.#host = host
    this.#name = options.serverName
    this.#config = options.server
    this.#store = options.store
    this.#timeout = options.timeoutMs
  }

  snapshot(): BridgeSnapshot {
    return {
      mode: 'server', status: this.#status, authorizationUrl: undefined,
      site: this.#config.jiraUrl || this.#config.confluenceUrl || undefined,
      siteMismatch: false, toolCount: this.#disposers.length, error: this.#error,
      server: {
        jiraUrl: this.#config.jiraUrl, confluenceUrl: this.#config.confluenceUrl,
        hasJiraCredential: !!this.#credentials.jira, hasConfluenceCredential: !!this.#credentials.confluence,
        allowInsecureHttp: this.#config.allowInsecureHttp,
      },
    }
  }

  rawNames(): readonly string[] { return [...this.#operations.keys()] }
  rawNameMatching(pattern: RegExp): string | undefined { return this.rawNames().find((name) => pattern.test(name)) }

  async start(): Promise<void> {
    if (this.#starting) return this.#starting
    const generation = this.#generation
    this.#starting = (async () => {
      await this.#store.load()
      if (this.#disposed || generation !== this.#generation) return
      this.#credentials = this.#store.current.serverCredentials ?? {}
      if (this.#credentials.jira || this.#credentials.confluence) await this.#begin({}, generation)
    })()
    try { await this.#starting } finally { this.#starting = undefined }
  }

  async authorize(input: Args = {}): Promise<BridgeSnapshot> {
    await this.#starting
    if (this.#disposed) return this.snapshot()
    if (!this.#running) await this.#begin(input, this.#generation)
    else await this.#running
    return this.snapshot()
  }

  async #begin(input: Args, generation: number): Promise<void> {
    this.#status = 'connecting'
    this.#error = undefined
    const run = this.#connect(input, generation).catch((error: unknown) => {
      if (!this.#disposed && generation === this.#generation) {
        this.#status = 'error'
        this.#error = error instanceof Error ? error.message : String(error)
        this.#host.logger.warn(`atlassian: server connection failed: ${this.#error}`)
      }
    })
    this.#running = run
    try { await run } finally { if (this.#running === run) this.#running = undefined }
  }

  async #connect(input: Args, generation: number): Promise<void> {
    const current = (): void => { if (this.#disposed || generation !== this.#generation) throw new Error('Connection cancelled') }
    const next: ServerCredentials = {
      jira: credential(input, 'jira', this.#credentials.jira),
      confluence: credential(input, 'confluence', this.#credentials.confluence),
    }
    const { jiraUrl, confluenceUrl, jiraCaFile, confluenceCaFile, allowInsecureHttp } = this.#config
    if (!jiraUrl && !confluenceUrl) throw new Error('Set a Jira or Confluence URL in the profile configuration')
    if (jiraUrl && !next.jira) throw new Error('Enter Jira credentials')
    if (confluenceUrl && !next.confluence) throw new Error('Enter Confluence credentials')
    const jira = jiraUrl && next.jira ? new ServerHttp(jiraUrl, next.jira, jiraCaFile, allowInsecureHttp) : undefined
    const confluence = confluenceUrl && next.confluence ? new ServerHttp(confluenceUrl, next.confluence, confluenceCaFile, allowInsecureHttp) : undefined
    if (jira) {
      const me = record(await this.#request(jira, 'GET', '/rest/api/2/myself'), 'Jira login response')
      if (typeof me['name'] !== 'string' && typeof me['key'] !== 'string') throw new Error('Jira did not return an authenticated user')
      current()
    }
    if (confluence) {
      const me = record(await this.#request(confluence, 'GET', '/rest/api/user/current'), 'Confluence login response')
      if (typeof me['username'] !== 'string' && typeof me['userKey'] !== 'string') throw new Error('Confluence did not return an authenticated user')
      current()
    }
    await this.#store.patch({ serverCredentials: next })
    current()
    const operations = this.#makeOperations(jira, confluence)
    this.#clearTools()
    const disposers: Array<() => void> = []
    try {
      for (const [rawName, op] of operations) disposers.push(this.#host.register(this.#definition(rawName, op)))
    } catch (error) {
      for (const dispose of disposers) dispose()
      throw error
    }
    this.#credentials = next
    this.#operations = operations
    this.#disposers = disposers
    this.#status = 'ready'
  }

  async disconnect(): Promise<BridgeSnapshot> {
    this.#generation++
    this.#status = 'idle'
    for (const controller of this.#controllers) controller.abort()
    await this.#starting?.catch(() => undefined)
    await this.#running
    this.#clearTools()
    await this.#store.destroy()
    this.#credentials = {}
    this.#status = 'idle'
    this.#error = undefined
    return this.snapshot()
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#generation++
    this.#status = 'idle'
    for (const controller of this.#controllers) controller.abort()
    await this.#starting?.catch(() => undefined)
    await this.#running
    this.#clearTools()
  }

  async callTool(rawName: string, args: Args, timeoutMs?: number): Promise<readonly unknown[]> {
    const op = this.#operations.get(rawName)
    if (!op || this.#status !== 'ready') throw new Error('Self-hosted Atlassian is not connected')
    return [{ type: 'text', text: JSON.stringify(await op.execute(args, undefined, timeoutMs)) }]
  }

  #clearTools(): void {
    for (const dispose of this.#disposers) dispose()
    this.#disposers = []
    this.#operations = new Map()
  }

  #definition(rawName: string, op: Operation): ToolDefinition {
    const definition = {
      name: publicToolName(this.#name, rawName),
      description: op.description,
      parameters: { type: 'object', properties: op.properties, required: op.required ?? [], additionalProperties: false },
      output: {
        schema: { type: 'object', properties: { content: { type: 'array', items: {} } }, required: ['content'], additionalProperties: false },
        render: (_args: unknown, result: unknown) => (result as { content: Array<{ type: 'text'; text: string }> }).content,
      },
      execute: async (args: unknown, exec: { signal?: AbortSignal }) => {
        if (this.#status !== 'ready' || this.#operations.get(rawName) !== op) throw new Error('Self-hosted Atlassian is not connected')
        return { content: [{ type: 'text', text: JSON.stringify(await op.execute(record(args, 'Arguments'), exec.signal)) }] }
      },
    }
    return definition as ToolDefinition
  }

  async #request(client: ServerHttp, method: 'GET' | 'POST' | 'PUT', path: string, query: Record<string, string | number | undefined> = {}, body?: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<unknown> {
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    if (signal?.aborted) controller.abort()
    else signal?.addEventListener('abort', abort, { once: true })
    this.#controllers.add(controller)
    try { return await client.request(method, path, query, body, timeoutMs ?? this.#timeout, controller.signal) }
    finally { this.#controllers.delete(controller); signal?.removeEventListener('abort', abort) }
  }

  #makeOperations(jira?: ServerHttp, confluence?: ServerHttp): Map<string, Operation> {
    const ops = new Map<string, Operation>()
    const add = (name: string, description: string, properties: Record<string, Schema>, required: string[], execute: Operation['execute']): void => {
      ops.set(name, { description, properties, required, execute })
    }
    add('getAccessibleAtlassianResources', 'List configured self-hosted Atlassian services.', {}, [], async () => [
      ...(jira ? [{ id: 'jira-server', url: jira.baseUrl, name: 'Jira Server' }] : []),
      ...(confluence ? [{ id: 'confluence-server', url: confluence.baseUrl, name: 'Confluence Server' }] : []),
    ])
    if (jira) {
      add('searchJiraIssuesUsingJql', 'Search Jira Server issues using JQL.', { jql: string, maxResults: integer, startAt: integer, fields: strings }, ['jql'], async (a, s, t) => {
        const startAt = offset(a['startAt'])
        const result = record(await this.#request(jira, 'POST', '/rest/api/2/search', {}, { jql: text(a, 'jql'), startAt, maxResults: limit(a['maxResults'], 50, 100), ...(Array.isArray(a['fields']) ? { fields: a['fields'] } : {}) }, s, t), 'Jira search response')
        const count = Array.isArray(result['issues']) ? result['issues'].length : 0
        return { ...result, isLast: typeof result['total'] === 'number' ? startAt + count >= result['total'] : count === 0 }
      })
      add('getJiraIssue', 'Read a Jira Server issue.', { issueIdOrKey: string }, ['issueIdOrKey'], (a, s, t) => this.#request(jira, 'GET', `/rest/api/2/issue/${key(a, 'issueIdOrKey')}`, {}, undefined, s, t))
      add('getVisibleJiraProjects', 'List visible Jira Server projects.', {}, [], (_a, s, t) => this.#request(jira, 'GET', '/rest/api/2/project', {}, undefined, s, t))
      add('getTransitionsForJiraIssue', 'Get the available transitions for a Jira issue.', { issueIdOrKey: string }, ['issueIdOrKey'], (a, s, t) => this.#request(jira, 'GET', `/rest/api/2/issue/${key(a, 'issueIdOrKey')}/transitions`, {}, undefined, s, t))
      add('transitionJiraIssue', 'Apply a specified Jira issue transition.', { issueIdOrKey: string, transition: object }, ['issueIdOrKey', 'transition'], (a, s, t) => this.#request(jira, 'POST', `/rest/api/2/issue/${key(a, 'issueIdOrKey')}/transitions`, {}, { transition: record(a['transition'], 'transition') }, s, t))
      add('createJiraIssue', 'Create a Jira issue with Jira Server fields.', { fields: object }, ['fields'], (a, s, t) => this.#request(jira, 'POST', '/rest/api/2/issue', {}, { fields: record(a['fields'], 'fields') }, s, t))
      add('editJiraIssue', 'Update fields on a Jira issue.', { issueIdOrKey: string, fields: object }, ['issueIdOrKey', 'fields'], (a, s, t) => this.#request(jira, 'PUT', `/rest/api/2/issue/${key(a, 'issueIdOrKey')}`, {}, { fields: record(a['fields'], 'fields') }, s, t))
      add('addCommentToJiraIssue', 'Add a Jira issue comment.', { issueIdOrKey: string, body: string }, ['issueIdOrKey', 'body'], (a, s, t) => this.#request(jira, 'POST', `/rest/api/2/issue/${key(a, 'issueIdOrKey')}/comment`, {}, { body: text(a, 'body') }, s, t))
    }
    if (confluence) {
      add('searchConfluenceUsingCql', 'Search self-hosted Confluence with CQL.', { cql: string, limit: integer, start: integer }, ['cql'], (a, s, t) => this.#request(confluence, 'GET', '/rest/api/content/search', { cql: text(a, 'cql'), limit: limit(a['limit'], 25, 100), start: offset(a['start']), expand: 'space,version' }, undefined, s, t))
      add('getConfluencePage', 'Read a Confluence page including its storage-format body and version.', { pageId: string }, ['pageId'], (a, s, t) => this.#request(confluence, 'GET', `/rest/api/content/${key(a, 'pageId', /^\d+$/)}`, { expand: 'body.storage,space,version,ancestors' }, undefined, s, t))
      add('getConfluenceSpaces', 'List accessible Confluence spaces.', { limit: integer, start: integer }, [], (a, s, t) => this.#request(confluence, 'GET', '/rest/api/space', { limit: limit(a['limit'], 25, 100), start: offset(a['start']) }, undefined, s, t))
      add('createConfluencePage', 'Create a Confluence page using storage-format XHTML.', { spaceKey: string, title: string, bodyStorage: string, parentId: string }, ['spaceKey', 'title', 'bodyStorage'], (a, s, t) => this.#request(confluence, 'POST', '/rest/api/content', {}, { type: 'page', title: text(a, 'title'), space: { key: key(a, 'spaceKey') }, body: { storage: { value: text(a, 'bodyStorage'), representation: 'storage' } }, ...(a['parentId'] ? { ancestors: [{ id: key(a, 'parentId', /^\d+$/) }] } : {}) }, s, t))
      add('updateConfluencePage', 'Replace a Confluence page using its current version and storage-format XHTML.', { pageId: string, title: string, bodyStorage: string, currentVersion: integer }, ['pageId', 'title', 'bodyStorage', 'currentVersion'], (a, s, t) => {
        const version = a['currentVersion']
        if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) throw new Error('currentVersion must be a positive integer')
        return this.#request(confluence, 'PUT', `/rest/api/content/${key(a, 'pageId', /^\d+$/)}`, {}, { id: key(a, 'pageId', /^\d+$/), type: 'page', title: text(a, 'title'), version: { number: version + 1 }, body: { storage: { value: text(a, 'bodyStorage'), representation: 'storage' } } }, s, t)
      })
    }
    return ops
  }
}
