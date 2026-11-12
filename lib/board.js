export class BoardError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'BoardError';
    }
}
function obj(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function val(value) { return typeof value === 'string' && value.trim() ? value : undefined; }
function issue(value, base) {
    const row = obj(value);
    const fields = obj(row['fields']);
    const state = obj(fields['status']);
    const category = obj(state['statusCategory']);
    const project = obj(fields['project']);
    const key = val(row['key']);
    if (!key)
        return undefined;
    return {
        key, id: val(row['id']) ?? key, summary: val(fields['summary']) ?? '(Untitled)',
        status: { name: val(state['name']) ?? 'Unknown', categoryKey: val(category['key']) ?? 'undefined', categoryName: val(category['name']) ?? 'Uncategorized', colorName: val(category['colorName']) ?? '' },
        type: val(obj(fields['issuetype'])['name']) ?? '', priority: val(obj(fields['priority'])['name']),
        assignee: val(obj(fields['assignee'])['displayName']), reporter: val(obj(fields['reporter'])['displayName']),
        updated: val(fields['updated']), projectKey: val(project['key']), projectName: val(project['name']),
        url: base ? `${base.replace(/\/$/, '')}/browse/${encodeURIComponent(key)}` : undefined,
    };
}
export class JiraBoard {
    #bridge;
    #resource;
    constructor(bridge) { this.#bridge = bridge; }
    available() { return !!this.#bridge.rawNameMatching(/searchJiraIssuesUsingJql/i); }
    get site() { return this.#resource?.site; }
    async #call(pattern, args, timeoutMs) {
        const name = this.#bridge.rawNameMatching(pattern);
        if (!name) {
            const state = this.#bridge.snapshot?.();
            if (state && state.status !== 'ready')
                throw new BoardError('not-connected', state.error || `Atlassian is not connected（${state.status}）`);
            throw new BoardError('missing-tool', `Missing Jira tool: ${pattern.source}`);
        }
        let blocks;
        try {
            blocks = await this.#bridge.callTool(name, args, timeoutMs);
        }
        catch (error) {
            throw new BoardError('tool-failed', error instanceof Error ? error.message : String(error));
        }
        const raw = blocks.map((entry) => val(obj(entry)['text']) ?? '').join('\n').trim().replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '');
        try {
            return JSON.parse(raw);
        }
        catch {
            throw new BoardError('unparsable', 'Jira response is not valid JSON');
        }
    }
    async cloudId() {
        if (this.#resource)
            return this.#resource.id;
        const data = await this.#call(/accessibleatlassianresources/i, {}, 20000);
        const list = Array.isArray(data) ? data : [data];
        for (const item of list) {
            const entry = obj(item);
            const id = val(entry['id']);
            const url = val(entry['url']);
            if (!id || !url)
                continue;
            try {
                const parsed = new URL(url);
                if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
                    continue;
                this.#resource = { id, base: `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}`, site: parsed.host };
                return id;
            }
            catch {
                continue;
            }
        }
        throw new BoardError('no-site', 'No accessible Jira site was found');
    }
    async load(query) {
        const id = await this.cloudId();
        const fallback = 'updated >= -180d ORDER BY updated DESC';
        let jql = query.jql?.trim() || fallback;
        let retried = false;
        let result;
        for (;;) {
            try {
                result = obj(await this.#call(/searchJiraIssuesUsingJql/i, { cloudId: id, jql, maxResults: query.limit, fields: ['summary', 'status', 'issuetype', 'priority', 'assignee', 'reporter', 'updated', 'project'] }, query.timeoutMs));
                break;
            }
            catch (error) {
                if (!retried && jql !== fallback && /unbounded|unrestricted|add a search restriction/i.test(String(error))) {
                    retried = true;
                    jql = fallback;
                    continue;
                }
                throw error;
            }
        }
        const rows = Array.isArray(result['issues']) ? result['issues'] : [];
        const issues = rows.map((value) => issue(value, this.#resource?.base)).filter((value) => !!value);
        return { issues, constrained: retried, jql, site: this.#resource?.site, cloudId: id, truncated: result['isLast'] === false, limit: query.limit };
    }
    async detail(key, timeoutMs) {
        const id = await this.cloudId();
        const data = obj(await this.#call(/^getJiraIssue$/i, { cloudId: id, issueIdOrKey: key, responseContentFormat: 'markdown' }, timeoutMs));
        const row = Array.isArray(data['issues']) ? data['issues'][0] : data;
        const found = issue(row, this.#resource?.base);
        if (!found)
            throw new BoardError('not-found', `Issue ${key} was not found`);
        return { issue: found, description: val(obj(obj(row)['fields'])['description']) ?? '' };
    }
    async transitions(key, timeoutMs) {
        const id = await this.cloudId();
        const data = obj(await this.#call(/getTransitionsForJiraIssue/i, { cloudId: id, issueIdOrKey: key }, timeoutMs));
        const rows = Array.isArray(data['transitions']) ? data['transitions'] : [];
        return rows.map((raw) => {
            const row = obj(raw);
            const target = obj(row['to']);
            const category = obj(target['statusCategory']);
            return { id: val(row['id']) ?? '', name: val(row['name']) ?? '', toName: val(target['name']) ?? val(row['name']) ?? '', toCategoryKey: val(category['key']) ?? 'undefined' };
        }).filter((row) => row.id && row.name);
    }
    async transition(key, transitionId, timeoutMs) {
        await this.#call(/^transitionJiraIssue$/i, { cloudId: await this.cloudId(), issueIdOrKey: key, transition: { id: transitionId } }, timeoutMs);
    }
    async projects(timeoutMs) {
        const data = await this.#call(/getVisibleJiraProjects/i, { cloudId: await this.cloudId() }, timeoutMs);
        const rows = Array.isArray(data) ? data : Array.isArray(obj(data)['values']) ? obj(data)['values'] : [];
        return rows.map((raw) => { const row = obj(raw); return { key: val(row['key']) ?? '', name: val(row['name']) ?? val(row['key']) ?? '' }; }).filter((row) => row.key).sort((a, b) => a.key.localeCompare(b.key));
    }
}
export function createBoard(bridge) { return new JiraBoard(bridge); }
