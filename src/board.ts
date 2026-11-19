import { decodeToolJson, selectJiraResource, type ConnectionResource } from './jira-resource.js'

export interface ToolBridge {
  rawNameMatching(pattern: RegExp): string | undefined
  callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<readonly unknown[]>
  snapshot?(): { status: string; error?: string | undefined }
  /** Changes whenever the connection is replaced, so cached site data can be invalidated. */
  epoch?(): number
  /** Site resolved while connecting, so the first board render need not repeat that MCP call. */
  resource?(): ConnectionResource | undefined
  allowsHttpResource?(url: URL): boolean
}
export interface BoardStatus { name: string; categoryKey: string; categoryName: string; colorName: string }
export interface BoardIssue {
  key: string; id: string; summary: string; status: BoardStatus; type: string
  priority?: string | undefined; assignee?: string | undefined; reporter?: string | undefined
  updated?: string | undefined; projectKey?: string | undefined; projectName?: string | undefined; url?: string | undefined
}
export interface BoardTransition { id: string; name: string; toName: string; toCategoryKey: string }
export interface BoardProject { key: string; name: string }
export interface BoardIssueDetail { issue: BoardIssue; description: string }
export interface BoardPayload { issues: readonly BoardIssue[]; constrained: boolean; jql: string; site: string | undefined; cloudId: string | undefined; truncated: boolean; limit: number }
export interface BoardQuery { jql?: string | undefined; limit: number; timeoutMs: number }
export class BoardError extends Error { constructor(readonly code: string, message: string) { super(message); this.name = 'BoardError' } }

type Obj = Record<string, unknown>
function obj(value: unknown): Obj { return value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {} }
function val(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value : undefined }
function issue(value: unknown, base?: string): BoardIssue | undefined {
  const row = obj(value); const fields = obj(row['fields']); const state = obj(fields['status']); const category = obj(state['statusCategory'])
  const project = obj(fields['project']); const key = val(row['key'])
  if (!key) return undefined
  return {
    key, id: val(row['id']) ?? key, summary: val(fields['summary']) ?? '(Untitled)',
    status: { name: val(state['name']) ?? 'Unknown', categoryKey: val(category['key']) ?? 'undefined', categoryName: val(category['name']) ?? 'Uncategorized', colorName: val(category['colorName']) ?? '' },
    type: val(obj(fields['issuetype'])['name']) ?? '', priority: val(obj(fields['priority'])['name']),
    assignee: val(obj(fields['assignee'])['displayName']), reporter: val(obj(fields['reporter'])['displayName']),
    updated: val(fields['updated']), projectKey: val(project['key']), projectName: val(project['name']),
    url: base ? `${base.replace(/\/$/, '')}/browse/${encodeURIComponent(key)}` : undefined,
  }
}

export class JiraBoard {
  readonly #bridge: ToolBridge
  #resource?: ConnectionResource
  #pending?: { epoch: number; promise: Promise<ConnectionResource> }
  constructor(bridge: ToolBridge) { this.#bridge = bridge }
  get site(): string | undefined { return this.#resource?.epoch === this.#epoch() ? this.#resource.site : undefined }

  #epoch(): number { return this.#bridge.epoch?.() ?? 0 }
  #checkEpoch(epoch: number): void {
    if (this.#epoch() !== epoch) throw new BoardError('not-connected', 'Atlassian connection changed; retry the request')
  }

  async #call(pattern: RegExp, args: Record<string, unknown>, timeoutMs?: number, epoch?: number): Promise<unknown> {
    if (epoch !== undefined) this.#checkEpoch(epoch)
    const name = this.#bridge.rawNameMatching(pattern)
    if (!name) {
      const state = this.#bridge.snapshot?.()
      if (state && state.status !== 'ready') throw new BoardError('not-connected', state.error || `Atlassian is not connected (${state.status})`)
      throw new BoardError('missing-tool', `Missing Jira tool: ${pattern.source}`)
    }
    let blocks: readonly unknown[]
    try { blocks = await this.#bridge.callTool(name, args, timeoutMs) }
    catch (error) { throw new BoardError('tool-failed', error instanceof Error ? error.message : String(error)) }
    try { return decodeToolJson(blocks) } catch { throw new BoardError('unparsable', 'Jira response is not valid JSON') }
  }

  async cloudId(): Promise<string> {
    const resource = await this.#getResource()
    this.#checkEpoch(resource.epoch)
    return resource.id
  }

  async #getResource(): Promise<ConnectionResource> {
    const epoch = this.#epoch()
    if (this.#resource?.epoch === epoch) return this.#resource
    // The bridge may already have resolved the site while connecting.
    const shared = this.#bridge.resource?.()
    if (shared?.epoch === epoch) return this.#resource = shared
    if (this.#pending?.epoch === epoch) return this.#pending.promise
    const promise = this.#resolveSite(epoch)
    this.#pending = { epoch, promise }
    try { return await promise } finally { if (this.#pending?.promise === promise) this.#pending = undefined }
  }

  async #resolveSite(epoch: number): Promise<ConnectionResource> {
    const data = await this.#call(/accessibleatlassianresources/i, {}, 20000)
    this.#checkEpoch(epoch)
    const resource = selectJiraResource(data, (url) => this.#bridge.allowsHttpResource?.(url) ?? false)
    if (!resource) throw new BoardError('no-site', 'No accessible Jira site was found')
    return this.#resource = { epoch, ...resource }
  }

  async load(query: BoardQuery): Promise<BoardPayload> {
    const { id, base, site, epoch } = await this.#getResource()
    const fallback = 'updated >= -180d ORDER BY updated DESC'
    let jql = query.jql?.trim() || fallback
    let retried = false
    let result: Obj
    for (;;) {
      try {
        result = obj(await this.#call(/searchJiraIssuesUsingJql/i, { cloudId: id, jql, maxResults: query.limit, fields: ['summary', 'status', 'issuetype', 'priority', 'assignee', 'reporter', 'updated', 'project'] }, query.timeoutMs, epoch))
        break
      } catch (error) {
        if (!retried && jql !== fallback && /unbounded|unrestricted|add a search restriction/i.test(String(error))) { retried = true; jql = fallback; continue }
        throw error
      }
    }
    const rows = Array.isArray(result['issues']) ? result['issues'] : []
    const issues = rows.map((value) => issue(value, base)).filter((value): value is BoardIssue => !!value)
    return { issues, constrained: retried, jql, site, cloudId: id, truncated: result['isLast'] === false, limit: query.limit }
  }

  async detail(key: string, timeoutMs: number): Promise<BoardIssueDetail> {
    const { id, base, epoch } = await this.#getResource()
    const data = obj(await this.#call(/^getJiraIssue$/i, { cloudId: id, issueIdOrKey: key, responseContentFormat: 'markdown' }, timeoutMs, epoch))
    const row = Array.isArray(data['issues']) ? data['issues'][0] : data
    const found = issue(row, base)
    if (!found) throw new BoardError('not-found', `Issue ${key} was not found`)
    return { issue: found, description: val(obj(obj(row)['fields'])['description']) ?? '' }
  }

  async transitions(key: string, timeoutMs: number): Promise<readonly BoardTransition[]> {
    const { id, epoch } = await this.#getResource()
    const data = obj(await this.#call(/getTransitionsForJiraIssue/i, { cloudId: id, issueIdOrKey: key }, timeoutMs, epoch))
    const rows = Array.isArray(data['transitions']) ? data['transitions'] : []
    return rows.map((raw) => {
      const row = obj(raw); const target = obj(row['to']); const category = obj(target['statusCategory'])
      return { id: val(row['id']) ?? '', name: val(row['name']) ?? '', toName: val(target['name']) ?? val(row['name']) ?? '', toCategoryKey: val(category['key']) ?? 'undefined' }
    }).filter((row) => row.id && row.name)
  }

  async transition(key: string, transitionId: string, timeoutMs: number): Promise<void> {
    const { id, epoch } = await this.#getResource()
    await this.#call(/^transitionJiraIssue$/i, { cloudId: id, issueIdOrKey: key, transition: { id: transitionId } }, timeoutMs, epoch)
  }
  async projects(timeoutMs: number): Promise<readonly BoardProject[]> {
    const { id, epoch } = await this.#getResource()
    const data = await this.#call(/getVisibleJiraProjects/i, { cloudId: id }, timeoutMs, epoch)
    const rows = Array.isArray(data) ? data : Array.isArray(obj(data)['values']) ? obj(data)['values'] as unknown[] : []
    return rows.map((raw) => { const row = obj(raw); return { key: val(row['key']) ?? '', name: val(row['name']) ?? val(row['key']) ?? '' } }).filter((row) => row.key).sort((a, b) => a.key.localeCompare(b.key))
  }
}
export function createBoard(bridge: ToolBridge): JiraBoard { return new JiraBoard(bridge) }
