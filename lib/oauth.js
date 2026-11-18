import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
export class RedirectRegistrationChanged extends Error {
}
const MAX_CLOUD_RESPONSE_BYTES = 10 * 1024 * 1024;
/** Bound decoded response bytes, including error bodies and individual SSE events. */
function limitCloudResponse(response, allowEvents) {
    if (!response.body)
        return response;
    const events = allowEvents && response.ok && /^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '');
    let size = 0;
    let lineHasContent = false;
    let afterCarriageReturn = false;
    const stream = response.body.pipeThrough(new TransformStream({
        transform(chunk, controller) {
            if (!events) {
                size += chunk.byteLength;
                if (size > MAX_CLOUD_RESPONSE_BYTES)
                    throw new Error('Atlassian Cloud response exceeded the size limit');
            }
            else {
                // SSE events end at an empty line. Track CR, LF and CRLF separately,
                // including separators split across network chunks. Scan with native
                // indexOf instead of a per-byte loop: this is the hot path for every
                // Cloud MCP response.
                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
                let pos = 0;
                if (afterCarriageReturn && buf.length > 0 && buf[0] === 10) {
                    size++;
                    if (size > MAX_CLOUD_RESPONSE_BYTES)
                        throw new Error('Atlassian Cloud event exceeded the size limit');
                    afterCarriageReturn = false;
                    pos = 1;
                }
                while (pos < buf.length) {
                    const cr = buf.indexOf(13, pos);
                    const lf = buf.indexOf(10, pos);
                    if (cr === -1 && lf === -1) {
                        size += buf.length - pos;
                        if (size > MAX_CLOUD_RESPONSE_BYTES)
                            throw new Error('Atlassian Cloud event exceeded the size limit');
                        lineHasContent = true;
                        afterCarriageReturn = false;
                        break;
                    }
                    const term = cr !== -1 && (lf === -1 || cr < lf) ? cr : lf;
                    size += term - pos + 1;
                    if (size > MAX_CLOUD_RESPONSE_BYTES)
                        throw new Error('Atlassian Cloud event exceeded the size limit');
                    if (term > pos)
                        lineHasContent = true;
                    if (!lineHasContent)
                        size = 0;
                    lineHasContent = false;
                    afterCarriageReturn = buf[term] === 13;
                    pos = term + 1;
                    if (afterCarriageReturn && pos < buf.length && buf[pos] === 10) {
                        size++;
                        if (size > MAX_CLOUD_RESPONSE_BYTES)
                            throw new Error('Atlassian Cloud event exceeded the size limit');
                        afterCarriageReturn = false;
                        pos++;
                    }
                }
            }
            controller.enqueue(chunk);
        },
    }));
    const limited = new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
    // The SDK uses these properties to resolve and report redirect targets.
    Object.defineProperties(limited, {
        url: { value: response.url },
        redirected: { value: response.redirected },
        type: { value: response.type },
    });
    return limited;
}
/** Loopback hosts may use plain HTTP for local MCP and OAuth endpoints. */
export function isLoopbackHost(hostname) {
    return ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
}
export function secureUrl(url, allowLoopbackHttp) {
    if (url.username || url.password || (url.protocol !== 'https:' && !(allowLoopbackHttp && url.protocol === 'http:' && isLoopbackHost(url.hostname)))) {
        throw new Error('Cloud and OAuth endpoints must use HTTPS without embedded credentials');
    }
}
/** Restrict every discovered OAuth and MCP endpoint, including redirect targets. */
export function createCloudFetch(serverUrl) {
    const allowLoopbackHttp = serverUrl.protocol === 'http:' && isLoopbackHost(serverUrl.hostname);
    secureUrl(serverUrl, allowLoopbackHttp);
    return {
        allowLoopbackHttp,
        fetch: async (value, init) => {
            secureUrl(new URL(value), allowLoopbackHttp);
            // The SDK performs its own same-origin redirect handling. Never let fetch
            // follow a redirect before its next target has passed the check above.
            const response = await globalThis.fetch(value, { ...init, redirect: init?.redirect === 'error' ? 'error' : 'manual' });
            const accept = new Headers(init?.headers).get('accept') ?? '';
            return limitCloudResponse(response, /(?:^|,)\s*text\/event-stream(?:\s*[,;]|\s*$)/i.test(accept));
        },
    };
}
export class CallbackServer {
    #server;
    #port = 0;
    #pending;
    get redirectUri() { return `http://127.0.0.1:${this.#port}/callback`; }
    get listening() { return this.#server?.listening === true; }
    async listen(preferredPort) {
        if (this.#server?.listening)
            return this.#port;
        const stale = this.#server;
        if (stale) {
            this.#server = undefined;
            this.cancelWait();
            await new Promise((resolve) => { stale.close(() => resolve()); });
        }
        const server = createServer((req, res) => {
            let url;
            try {
                url = new URL(req.url ?? '/', 'http://127.0.0.1');
            }
            catch {
                res.writeHead(400).end();
                return;
            }
            if (req.method !== 'GET' || url.pathname !== '/callback') {
                res.writeHead(404).end();
                return;
            }
            const pending = this.#pending;
            const state = url.searchParams.get('state');
            if (!pending || state !== pending.state) {
                this.#reply(res, false, 'Authorization state is invalid or expired.');
                return;
            }
            const error = url.searchParams.get('error');
            if (error) {
                const detail = url.searchParams.get('error_description') || error;
                this.#reply(res, false, `Authorization failed: ${detail}`);
                pending.complete(new Error(`authorization failed: ${detail}`));
                return;
            }
            const code = url.searchParams.get('code');
            if (!code) {
                this.#reply(res, false, 'Authorization code is missing.');
                pending.complete(new Error('authorization callback carried no code'));
                return;
            }
            this.#reply(res, true, 'Authorization complete. Return to DSH.');
            pending.complete({ code, state });
        });
        const bind = (port) => new Promise((resolve, reject) => {
            const failed = (error) => reject(error);
            server.once('error', failed);
            server.listen(port, '127.0.0.1', () => { server.off('error', failed); resolve(server.address().port); });
        });
        try {
            this.#port = await bind(preferredPort);
        }
        catch (error) {
            const code = error.code;
            // A privileged or unavailable port must not leave redirectUri pointing at
            // port 0; retry any bind failure that a dynamic port can avoid.
            if (preferredPort === 0 || (code !== 'EADDRINUSE' && code !== 'EACCES' && code !== 'EADDRNOTAVAIL'))
                throw error;
            this.#port = await bind(0);
        }
        server.on('error', () => this.cancelWait());
        this.#server = server;
        return this.#port;
    }
    waitForCode(timeoutMs, state, signal) {
        if (!state)
            return Promise.reject(new Error('authorization URL did not contain state'));
        this.cancelWait();
        return new Promise((resolve, reject) => {
            let timer;
            const done = (value) => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', abort);
                this.#pending = undefined;
                if (value instanceof Error)
                    reject(value);
                else
                    resolve(value);
            };
            const abort = () => done(new Error('authorization cancelled'));
            this.#pending = { state, complete: done };
            timer = setTimeout(() => done(new Error('authorization timed out')), timeoutMs);
            timer.unref();
            if (signal?.aborted)
                abort();
            else
                signal?.addEventListener('abort', abort, { once: true });
        });
    }
    cancelWait() { this.#pending?.complete(new Error('authorization cancelled')); }
    async close() {
        this.cancelWait();
        const server = this.#server;
        this.#server = undefined;
        if (!server)
            return;
        await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); });
    }
    #reply(res, ok, text) {
        const safe = text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
        res.writeHead(ok ? 200 : 400, {
            'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
            'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
            'x-content-type-options': 'nosniff',
        });
        res.end(`<!doctype html><meta charset="utf-8"><title>DSH Atlassian</title><p>${safe}</p>`);
    }
}
export class AtlassianOAuthProvider {
    #store;
    #redirect;
    #onUrl;
    #allowLoopbackHttp;
    #active;
    #tokenRead;
    #refreshExpected;
    #authFinished;
    #lease;
    #observedTokens;
    #signal;
    #resetObservation;
    constructor(options) {
        this.#store = options.store;
        this.#redirect = options.redirectUri;
        this.#onUrl = options.onAuthorizationUrl;
        this.#allowLoopbackHttp = options.allowLoopbackHttp;
        this.#active = options.active ?? (() => true);
        this.#tokenRead = options.tokenRead ?? (() => undefined);
        this.#refreshExpected = options.refreshExpected ?? (() => undefined);
        this.#authFinished = options.authFinished ?? (() => undefined);
        this.#lease = options.lease ?? (() => undefined);
        this.#observedTokens = options.observedTokens ?? (() => undefined);
        this.#signal = options.signal ?? (() => undefined);
        this.#resetObservation = options.resetObservation ?? (() => undefined);
    }
    #check() { if (!this.#active())
        throw new Error('atlassian: connection cancelled'); }
    get redirectUrl() { this.#check(); return this.#redirect(); }
    get clientMetadata() {
        return { client_name: 'DSH Atlassian', redirect_uris: [this.redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
    }
    state() { this.#check(); return randomBytes(16).toString('hex'); }
    clientInformation() { this.#check(); return this.#store.current.clientInformation; }
    async saveClientInformation(value) { await this.#store.patch({ clientInformation: value }, this.#active, this.#lease(), this.#observedTokens(), this.#signal(), true); }
    tokens() { this.#check(); const value = this.#store.current.tokens; this.#tokenRead(value); return value; }
    async saveTokens(value) {
        try {
            await this.#store.saveTokens(value, this.#active, this.#refreshExpected() ?? this.#observedTokens(), this.#lease(), this.#signal(), true);
        }
        finally {
            this.#authFinished();
        }
    }
    redirectToAuthorization(url) {
        this.#check();
        secureUrl(url, this.#allowLoopbackHttp);
        this.#onUrl(url.href);
        this.#authFinished();
    }
    async saveCodeVerifier(value) {
        try {
            const registered = this.#store.current.redirectUri;
            const actual = this.#redirect();
            if (registered && registered !== actual) {
                await this.#store.rebindRedirect(actual, this.#observedTokens(), this.#active, this.#lease(), this.#signal());
                throw new RedirectRegistrationChanged('atlassian: callback changed; restarting authorization');
            }
            await this.#store.patch({ codeVerifier: value }, this.#active, this.#lease(), this.#observedTokens(), this.#signal(), true);
        }
        finally {
            this.#authFinished();
        }
    }
    codeVerifier() {
        this.#check();
        const value = this.#store.current.codeVerifier;
        if (!value)
            throw new Error('missing PKCE verifier');
        return value;
    }
    async invalidateCredentials(scope) {
        try {
            const expected = this.#refreshExpected() ?? this.#observedTokens();
            let cleared = false;
            if (scope === 'all')
                cleared = await this.#store.clearCredentialsIf(this.#active, expected, this.#lease(), this.#signal(), true, 'tokens', 'clientInformation', 'codeVerifier');
            else if (scope === 'client')
                cleared = await this.#store.clearCredentialsIf(this.#active, expected, this.#lease(), this.#signal(), true, 'clientInformation');
            else if (scope === 'tokens')
                cleared = await this.#store.clearCredentialsIf(this.#active, expected, this.#lease(), this.#signal(), true, 'tokens');
            else if (scope === 'verifier')
                cleared = await this.#store.clearCredentialsIf(this.#active, expected, this.#lease(), this.#signal(), true, 'codeVerifier');
            // Only a clear this operation actually performed invalidates its observation.
            // If another process removed or replaced the session, the stale observation
            // must keep refusing credential writes.
            if (cleared && (scope === 'all' || scope === 'tokens'))
                this.#resetObservation();
        }
        finally {
            this.#authFinished();
        }
    }
}
