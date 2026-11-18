import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { AtlassianOAuthProvider, CallbackServer, RedirectRegistrationChanged, createCloudFetch, secureUrl } from './oauth.js';
import { OAuthTokensSchema } from '@modelcontextprotocol/sdk/shared/auth.js';
import { openInBrowser } from './open-url.js';
import { sameTokens } from './store.js';
async function waitForFlight(flight, signal) {
    if (signal.aborted)
        throw new Error('atlassian: connection cancelled');
    await new Promise((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('atlassian: connection cancelled')); };
        signal.addEventListener('abort', abort, { once: true });
        void flight.then(() => { signal.removeEventListener('abort', abort); resolve(); }, reject);
        if (signal.aborted)
            abort();
    });
}
export function publicToolName(server, tool) {
    const raw = `mcp__${server}__${tool}`;
    const clean = raw.replace(/[^A-Za-z0-9_-]/g, '_');
    if (raw === clean && clean.length <= 64)
        return clean;
    const suffix = createHash('sha256').update(`${server}\0${tool}`).digest('hex').slice(0, 12);
    return `${clean.slice(0, 51)}_${suffix}`;
}
function display(content) {
    if (!Array.isArray(content))
        return '';
    return content.map((part) => {
        if (!part || typeof part !== 'object')
            return '';
        const block = part;
        return block['type'] === 'text' && typeof block['text'] === 'string' ? block['text'] : `[${String(block['type'] ?? 'unknown')} content]`;
    }).filter(Boolean).join('\n\n');
}
export class AtlassianBridge {
    #host;
    #options;
    #callback = new CallbackServer();
    #operation = new AsyncLocalStorage();
    #provider;
    #fetch;
    #client;
    #tools = new Map();
    #status = 'idle';
    #url;
    #error;
    #work;
    #boot;
    #generation = 0;
    #disposed = false;
    #controller = new AbortController();
    #flight;
    #refreshes = new Set();
    #waiters = new Set();
    #waiting = false;
    #allowLoopbackHttp;
    constructor(host, options) {
        this.#host = host;
        this.#options = options;
        const network = createCloudFetch(new URL(options.url));
        this.#allowLoopbackHttp = network.allowLoopbackHttp;
        const active = () => {
            const operation = this.#operation.getStore();
            return !this.#disposed && (!operation || (operation.generation === this.#generation && !operation.signal.aborted));
        };
        this.#fetch = async (value, init) => {
            const operation = this.#operation.getStore();
            if (!operation) {
                if (init?.body instanceof URLSearchParams && init.body.get('grant_type') === 'refresh_token') {
                    throw new Error('atlassian: refresh requires an active connection operation');
                }
                return network.fetch(value, init);
            }
            if (!active())
                throw new Error('atlassian: connection cancelled');
            const signals = [operation.signal];
            if (init?.signal)
                signals.push(init.signal);
            const signal = AbortSignal.any(signals);
            const authorization = new Headers(init?.headers).get('authorization');
            if (authorization?.startsWith('Bearer ')) {
                const current = this.#options.store.current.tokens;
                const previous = operation.observedTokens;
                operation.observedTokens = previous && authorization === `Bearer ${previous.access_token}` ? previous
                    : current && authorization === `Bearer ${current.access_token}` ? current : undefined;
            }
            const refresh = init?.body instanceof URLSearchParams && init.body.get('grant_type') === 'refresh_token';
            if (!refresh)
                return network.fetch(value, { ...init, signal });
            // A synthetic response must obey the same URL policy as a network request.
            secureUrl(new URL(value), network.allowLoopbackHttp);
            const expected = operation.observedTokens;
            while (this.#flight && this.#flight.owner !== operation)
                await waitForFlight(this.#flight.done, signal);
            if (!active() || signal.aborted)
                throw new Error('atlassian: connection cancelled');
            operation.refreshExpected = expected;
            const lease = await this.#options.store.acquire(signal);
            if (!active() || signal.aborted) {
                lease.release();
                throw new Error('atlassian: connection cancelled');
            }
            const current = this.#options.store.current.tokens;
            if (expected && !sameTokens(current, expected)) {
                lease.release();
                return new Response(JSON.stringify(current ?? { error: 'invalid_grant' }), { status: current ? 200 : 400, headers: { 'content-type': 'application/json' } });
            }
            if (!this.#flight) {
                let complete;
                const done = new Promise((resolve) => { complete = resolve; });
                let pending = true;
                let requested = false;
                const release = () => {
                    if (pending) {
                        requested = true;
                        return;
                    }
                    if (this.#flight?.owner === operation) {
                        this.#flight = undefined;
                        signal.removeEventListener('abort', release);
                        complete();
                    }
                    if (operation.lease === lease) {
                        operation.lease = undefined;
                        lease.release();
                    }
                    if (operation.releaseRefresh === release)
                        operation.releaseRefresh = undefined;
                };
                this.#flight = { owner: operation, done };
                operation.exchangePending = true;
                operation.lease = lease;
                operation.releaseRefresh = release;
                signal.addEventListener('abort', release, { once: true });
                if (signal.aborted) {
                    operation.exchangePending = false;
                    pending = false;
                    release();
                    throw new Error('atlassian: connection cancelled');
                }
                const exchange = (async () => {
                    try {
                        // A cancelled local request may still rotate its token remotely. Finish
                        // and persist the response before allowing another process to refresh.
                        // Bound the cross-process refresh lock even when toolCallTimeoutMs is huge.
                        const response = await network.fetch(value, { ...init, signal: AbortSignal.timeout(Math.min(120000, Math.max(30000, this.#options.toolCallTimeoutMs))) });
                        if (response.ok) {
                            const parsed = OAuthTokensSchema.omit({ issuer: true }).safeParse(await response.clone().json());
                            if (!parsed.success)
                                throw new Error('atlassian: invalid refresh response');
                            const refreshToken = init?.body instanceof URLSearchParams ? init.body.get('refresh_token') ?? undefined : undefined;
                            const issuer = expected?.issuer ?? this.#options.store.current.clientInformation?.issuer;
                            const tokens = { refresh_token: refreshToken, ...parsed.data, ...(issuer ? { issuer } : {}) };
                            await this.#options.store.saveTokens(tokens, () => true, expected, lease);
                        }
                        return response;
                    }
                    catch (error) {
                        // If the response was lost, the server may already have rotated it.
                        // Do not let another process reuse the uncertain refresh token.
                        await this.#options.store.clearCredentialsIf(() => true, expected, lease, undefined, true, 'tokens');
                        throw error;
                    }
                    finally {
                        operation.exchangePending = false;
                        pending = false;
                        if (requested)
                            release();
                    }
                })();
                this.#refreshes.add(exchange);
                try {
                    return await exchange;
                }
                finally {
                    this.#refreshes.delete(exchange);
                }
            }
            lease.release();
            throw new Error('atlassian: refresh is already in progress');
        };
        this.#provider = new AtlassianOAuthProvider({
            store: options.store, redirectUri: () => this.#callback.redirectUri, allowLoopbackHttp: network.allowLoopbackHttp, logger: host.logger,
            onAuthorizationUrl: (url) => {
                if (!active())
                    return;
                this.#setUrl(url);
                if (this.#status === 'ready') {
                    this.#setStatus('error');
                    this.#error = 'Atlassian authorization expired; reconnect to authorize again';
                }
            },
            active,
            tokenRead: (tokens) => { const op = this.#operation.getStore(); if (op && !op.observedTokens)
                op.observedTokens = tokens; },
            refreshExpected: () => this.#operation.getStore()?.refreshExpected,
            authFinished: () => { const op = this.#operation.getStore(); op?.releaseRefresh?.(); if (op)
                op.refreshExpected = undefined; },
            lease: () => this.#operation.getStore()?.lease,
            observedTokens: () => this.#operation.getStore()?.observedTokens,
            signal: () => this.#operation.getStore()?.signal,
            resetObservation: () => {
                const operation = this.#operation.getStore();
                if (!operation)
                    return;
                operation.observedTokens = undefined;
                operation.refreshExpected = undefined;
            },
        });
    }
    #newOperation() { return { generation: this.#generation, signal: this.#controller.signal }; }
    epoch() { return this.#generation; }
    #setStatus(status) { this.#status = status; this.#wake(); }
    #setUrl(url) { this.#url = url; this.#wake(); }
    #wake() { const waiters = [...this.#waiters]; this.#waiters.clear(); for (const wake of waiters)
        wake(); }
    /** Resolve as soon as the predicate holds, or at the deadline like the previous polling loop. */
    #waitFor(timeoutMs, done) {
        return new Promise((resolve) => {
            if (done()) {
                resolve();
                return;
            }
            const finish = () => { clearTimeout(timer); this.#waiters.delete(wake); resolve(); };
            const wake = () => { if (done())
                finish();
            else
                this.#waiters.add(wake); };
            const timer = setTimeout(finish, timeoutMs);
            timer.unref();
            this.#waiters.add(wake);
        });
    }
    snapshot() {
        const site = this.#options.store.current.site;
        let mismatch = false;
        if (site && this.#options.expectedSite.trim()) {
            try {
                const raw = this.#options.expectedSite.trim();
                mismatch = new URL(raw.includes('://') ? raw : `https://${raw}`).host.toLowerCase() !== site.toLowerCase();
            }
            catch {
                mismatch = true;
            }
        }
        // Only publish a URL while a callback wait is armed; following it otherwise
        // would reach an unbound callback listener and fail with an HTTP 400.
        return { status: this.#status, authorizationUrl: this.#waiting ? this.#url : undefined, site, siteMismatch: mismatch, toolCount: this.#tools.size, error: this.#error };
    }
    rawNames() { return [...this.#tools.values()].map((value) => value.raw); }
    rawNameMatching(pattern) { return this.rawNames().find((name) => pattern.test(name)); }
    async start() {
        if (this.#boot)
            return this.#boot;
        const generation = this.#generation;
        const boot = (async () => {
            this.#setStatus('connecting');
            await this.#options.store.load(this.#controller.signal);
            if (this.#disposed || generation !== this.#generation)
                return;
            await this.#callback.listen(this.#options.redirectPort);
            if (this.#disposed || generation !== this.#generation)
                return;
            await this.#options.store.prepareRedirect(this.#callback.redirectUri, this.#controller.signal);
            if (this.#disposed || generation !== this.#generation)
                return;
            this.#launch(false, generation);
            await this.#waitFor(15000, () => this.#status !== 'connecting');
        })();
        this.#boot = boot;
        try {
            await boot;
        }
        catch (error) {
            if (!this.#disposed && generation === this.#generation) {
                this.#setStatus('error');
                this.#error = error instanceof Error ? error.message : String(error);
            }
            throw error;
        }
        finally {
            if (this.#boot === boot)
                this.#boot = undefined;
        }
    }
    async authorize() {
        await this.#boot;
        if (this.#disposed || this.#status === 'ready')
            return this.snapshot();
        if (!this.#callback.listening)
            await this.#callback.listen(this.#options.redirectPort);
        if (this.#status === 'authorizing' && this.#url) {
            if (this.#options.autoOpenBrowser)
                await openInBrowser(this.#url);
            return this.snapshot();
        }
        if (!this.#work) {
            await this.#closeClient();
            this.#clearTools();
            this.#setUrl(undefined);
            this.#launch(true, this.#generation);
        }
        // Wait for a settled state: the authorization URL is published just before
        // the status leaves 'connecting', and callers act on the returned status.
        await this.#waitFor(20000, () => this.#status !== 'connecting');
        return this.snapshot();
    }
    #launch(open, generation) {
        const work = this.#connect(open, generation).catch((error) => {
            if (!this.#disposed && generation === this.#generation) {
                this.#setStatus('error');
                this.#error = error instanceof Error ? error.message : String(error);
                this.#host.logger.error(`atlassian: ${this.#error}`);
            }
        });
        this.#work = work;
        void work.finally(() => { if (this.#work === work)
            this.#work = undefined; });
    }
    async #connect(open, generation) {
        const check = () => { if (this.#disposed || generation !== this.#generation)
            throw new Error('connection cancelled'); };
        for (let attempt = 0; attempt < 2; attempt++) {
            check();
            this.#setStatus('connecting');
            this.#error = undefined;
            const client = new Client({ name: 'dsh-atlassian', version: '0.1.12' });
            // Releasing the session lease here would race the SDK's saveTokens; an
            // exchange that is still in flight is released by its own finally block.
            client.onerror = () => { const operation = this.#operation.getStore(); if (operation?.exchangePending)
                operation.releaseRefresh?.(); };
            const transport = new StreamableHTTPClientTransport(new URL(this.#options.url), { authProvider: this.#provider, fetch: this.#fetch });
            const send = transport.send.bind(transport);
            transport.send = (message, options) => {
                const operation = this.#newOperation();
                return this.#operation.run(operation, async () => {
                    try {
                        return await send(message, options);
                    }
                    catch (error) {
                        operation.releaseRefresh?.();
                        if (!this.#disposed && operation.generation === this.#generation && this.#status === 'ready' && operation.observedTokens && !this.#options.store.current.tokens) {
                            this.#setStatus('error');
                            this.#error = 'Atlassian authorization expired; reconnect to authorize again';
                        }
                        if (!(error instanceof RedirectRegistrationChanged))
                            throw error;
                        operation.observedTokens = undefined;
                        operation.refreshExpected = undefined;
                        return send(message, options);
                    }
                });
            };
            try {
                await client.connect(transport);
                check();
            }
            catch (error) {
                await transport.close().catch(() => undefined);
                check();
                if (!(error instanceof UnauthorizedError) || attempt !== 0)
                    throw error;
                const state = this.#url ? new URL(this.#url).searchParams.get('state') ?? undefined : undefined;
                const waiting = this.#callback.waitForCode(this.#options.authorizationTimeoutMs, state);
                this.#waiting = true;
                this.#setStatus('authorizing');
                if (open && this.#url && this.#options.autoOpenBrowser)
                    void openInBrowser(this.#url);
                try {
                    const callback = await waiting;
                    check();
                    await this.#operation.run(this.#newOperation(), () => auth(this.#provider, { serverUrl: this.#options.url, authorizationCode: callback.code, fetchFn: this.#fetch }));
                    check();
                    await this.#options.store.clearCredentialsIf(() => !this.#disposed && generation === this.#generation, undefined, undefined, this.#controller.signal, false, 'codeVerifier');
                }
                finally {
                    this.#waiting = false;
                }
                continue;
            }
            this.#client = client;
            await this.#registerTools(client);
            check();
            await this.#readSite(client, generation, this.#controller.signal);
            check();
            this.#setUrl(undefined);
            this.#setStatus('ready');
            return;
        }
        throw new Error('Atlassian authorization did not establish a connection');
    }
    async #registerTools(client) {
        const found = [];
        const seen = new Set();
        let cursor;
        do {
            if (seen.size >= 100)
                throw new Error('MCP server returned too many tool pages');
            const page = await client.listTools(cursor ? { cursor } : {});
            found.push(...page.tools);
            if (found.length > 1000)
                throw new Error('MCP server returned too many tools');
            cursor = page.nextCursor;
            if (cursor && seen.has(cursor))
                throw new Error('MCP server repeated a continuation cursor');
            if (cursor)
                seen.add(cursor);
        } while (cursor);
        const names = new Set();
        for (const tool of found) {
            const name = publicToolName(this.#options.serverName, tool.name);
            if (names.has(name))
                throw new Error('MCP server returned duplicate tool names');
            names.add(name);
        }
        this.#clearTools();
        try {
            for (const tool of found) {
                const name = publicToolName(this.#options.serverName, tool.name);
                const definition = {
                    name, description: tool.description ?? '', parameters: tool.inputSchema,
                    output: {
                        schema: { type: 'object', properties: { content: { type: 'array', items: {} } }, required: ['content'], additionalProperties: false },
                        render: (_args, result) => [{ type: 'text', text: display(result?.content) }],
                    },
                    execute: async (args, context) => {
                        const result = await client.callTool({ name: tool.name, arguments: (typeof args === 'object' && args !== null ? args : {}) }, undefined, { timeout: this.#options.toolCallTimeoutMs, signal: context.signal });
                        if (result.isError)
                            throw new Error(display(result.content));
                        return { content: result.content };
                    },
                };
                this.#tools.set(name, { raw: tool.name, dispose: this.#host.register(definition) });
            }
        }
        catch (error) {
            this.#clearTools();
            throw error;
        }
    }
    async #readSite(client, generation, signal) {
        const name = this.rawNameMatching(/accessibleatlassianresources/i);
        if (!name)
            return;
        try {
            const result = await client.callTool({ name, arguments: {} }, undefined, { timeout: 20000, signal });
            const items = JSON.parse(display(result.content));
            const first = Array.isArray(items) ? items[0] : items;
            if (first && typeof first === 'object' && typeof first['url'] === 'string') {
                const reported = new URL(first['url']);
                secureUrl(reported, this.#allowLoopbackHttp);
                await this.#options.store.patch({ site: reported.host }, () => !this.#disposed && generation === this.#generation && !signal.aborted, undefined, undefined, signal);
            }
        }
        catch { /* The connection can work without a site label. */ }
    }
    async callTool(rawName, args, timeoutMs) {
        if (!this.#client || this.#status !== 'ready')
            throw new Error('Atlassian is not connected');
        const result = await this.#client.callTool({ name: rawName, arguments: args }, undefined, { timeout: timeoutMs ?? this.#options.toolCallTimeoutMs });
        if (result.isError)
            throw new Error(display(result.content));
        return Array.isArray(result.content) ? result.content : [];
    }
    async disconnect() {
        this.#generation++;
        this.#controller.abort();
        this.#controller = new AbortController();
        this.#setStatus('idle');
        this.#callback.cancelWait();
        await this.#boot?.catch(() => undefined);
        this.#callback.cancelWait();
        await this.#work;
        await Promise.allSettled([...this.#refreshes]);
        await this.#closeClient();
        this.#clearTools();
        await this.#options.store.destroy();
        this.#setUrl(undefined);
        this.#error = undefined;
        return this.snapshot();
    }
    async dispose() {
        if (this.#disposed)
            return;
        this.#disposed = true;
        this.#generation++;
        this.#controller.abort();
        this.#setStatus('idle');
        this.#callback.cancelWait();
        await this.#boot?.catch(() => undefined);
        this.#callback.cancelWait();
        await this.#work;
        await Promise.allSettled([...this.#refreshes]);
        await this.#closeClient();
        this.#clearTools();
        await this.#callback.close();
    }
    async #closeClient() {
        const client = this.#client;
        this.#client = undefined;
        await client?.close().catch(() => undefined);
    }
    #clearTools() {
        for (const value of this.#tools.values())
            value.dispose();
        this.#tools.clear();
    }
}
