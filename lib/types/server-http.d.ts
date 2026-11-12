import type { ServerCredential } from './store.js';
/** One explicitly configured Atlassian Server/Data Center REST endpoint. */
export declare class ServerHttp {
    #private;
    constructor(base: string, credential: ServerCredential, caFile: string, allowInsecureHttp: boolean);
    get baseUrl(): string;
    request(method: 'GET' | 'POST' | 'PUT', path: string, query?: Record<string, string | number | undefined>, body?: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<unknown>;
}
