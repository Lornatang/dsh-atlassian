import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { rootCertificates } from 'node:tls';
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
/** One explicitly configured Atlassian Server/Data Center REST endpoint. */
export class ServerHttp {
    #base;
    #credential;
    #ca;
    constructor(base, credential, caFile, allowInsecureHttp) {
        let url;
        try {
            url = new URL(base);
        }
        catch {
            throw new Error('Invalid Atlassian service URL');
        }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
            throw new Error('The Atlassian URL must be an HTTP(S) base URL without credentials or query parameters');
        }
        if (url.protocol === 'http:' && !allowInsecureHttp) {
            throw new Error('HTTP transmits credentials in plaintext; set allowInsecureHttp: true only after accepting this risk');
        }
        if (!credential.secret || /[\r\n]/.test(credential.secret) || /[\r\n:]/.test(credential.username ?? '')) {
            throw new Error('Atlassian credentials are invalid');
        }
        this.#base = url;
        this.#credential = credential;
        this.#ca = caFile ? [...rootCertificates, readFileSync(caFile, 'utf8')] : undefined;
    }
    get baseUrl() { return this.#base.href.replace(/\/$/, ''); }
    async request(method, path, query = {}, body, timeoutMs = 60000, signal) {
        const target = new URL(this.#base.href);
        target.pathname = `${target.pathname.replace(/\/$/, '')}${path}`;
        for (const [key, value] of Object.entries(query))
            if (value !== undefined)
                target.searchParams.set(key, String(value));
        const authorization = this.#credential.username
            ? `Basic ${Buffer.from(`${this.#credential.username}:${this.#credential.secret}`).toString('base64')}`
            : `Bearer ${this.#credential.secret}`;
        const payload = body === undefined ? undefined : JSON.stringify(body);
        return await new Promise((resolve, reject) => {
            let settled = false;
            const finish = (error, value) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                signal?.removeEventListener('abort', abort);
                if (error)
                    reject(error);
                else
                    resolve(value);
            };
            const transport = target.protocol === 'https:' ? https : http;
            const req = transport.request(target, {
                method,
                agent: false,
                // Explicitly supplied trust anchors may be intermediates or a pinned
                // self-signed server certificate. Keep hostname and TLS checks enabled.
                ...(target.protocol === 'https:' && this.#ca ? { ca: [...this.#ca], allowPartialTrustChain: true } : {}),
                headers: {
                    accept: 'application/json',
                    authorization,
                    ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
                },
            }, (res) => {
                const chunks = [];
                let size = 0;
                res.on('data', (chunk) => {
                    size += chunk.length;
                    if (size > MAX_RESPONSE_BYTES) {
                        req.destroy(new Error('Atlassian response exceeded the size limit'));
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on('error', (error) => finish(error));
                res.on('end', () => {
                    const status = res.statusCode ?? 0;
                    // Do not follow redirects with credentials or echo server error bodies.
                    if (status < 200 || status >= 300) {
                        finish(new Error(`Atlassian REST request failed: HTTP ${status}`));
                        return;
                    }
                    const text = Buffer.concat(chunks).toString('utf8');
                    if (text === '') {
                        finish(undefined, {});
                        return;
                    }
                    try {
                        finish(undefined, JSON.parse(text));
                    }
                    catch {
                        finish(new Error('Atlassian REST response was not valid JSON'));
                    }
                });
            });
            const abort = () => { req.destroy(new Error('Atlassian request cancelled')); };
            const timer = setTimeout(() => req.destroy(new Error('Atlassian request timed out')), timeoutMs);
            timer.unref();
            req.on('error', (error) => finish(error));
            if (signal?.aborted)
                abort();
            else
                signal?.addEventListener('abort', abort, { once: true });
            req.end(payload);
        });
    }
}
