import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
export interface StoredSession {
    version: 1;
    redirectUri?: string;
    clientInformation?: OAuthClientInformationMixed;
    tokens?: OAuthTokens;
    codeVerifier?: string;
    site?: string;
    serverCredentials?: ServerCredentials;
}
export interface ServerCredential {
    username?: string;
    secret: string;
}
export interface ServerCredentials {
    jira?: ServerCredential;
    confluence?: ServerCredential;
}
/** Compare the bearer and refresh credentials, not object identity across reloads. */
export declare function sameTokens(left: OAuthTokens | undefined, right: OAuthTokens | undefined): boolean;
export interface SessionLease {
    readonly owner: SessionStore;
    readonly active: boolean;
    run<T>(work: () => Promise<T>): Promise<T>;
    release(): void;
}
/** Keep credentials separate for each DSH profile and server. */
export declare function sessionFileFor(serverName: string, url: string, patchPath?: string): string;
/** Serialize state changes and replace the file only after a complete write. */
export declare class SessionStore {
    #private;
    constructor(file: string);
    get file(): string;
    get current(): StoredSession;
    /** Hold an OS-backed lock across the complete OAuth refresh exchange. */
    acquire(signal?: AbortSignal): Promise<SessionLease>;
    load(signal?: AbortSignal): Promise<StoredSession>;
    patch(patch: Partial<StoredSession>, active?: () => boolean, lease?: SessionLease, expected?: OAuthTokens, signal?: AbortSignal, guard?: boolean): Promise<void>;
    /** A secondary process must not discard credentials merely because its callback port is busy. */
    prepareRedirect(actual: string, signal?: AbortSignal): Promise<void>;
    /** Re-register only when a new interactive flow needs a different callback. */
    rebindRedirect(actual: string, expected: OAuthTokens | undefined, active: () => boolean, lease?: SessionLease, signal?: AbortSignal): Promise<void>;
    saveTokens(tokens: OAuthTokens, active: () => boolean, expected?: OAuthTokens, lease?: SessionLease, signal?: AbortSignal, guard?: boolean): Promise<void>;
    clearCredentialsIf(active: () => boolean, expected: OAuthTokens | undefined, lease: SessionLease | undefined, signal: AbortSignal | undefined, guard: boolean, ...fields: readonly (keyof StoredSession)[]): Promise<void>;
    clear(...fields: readonly (keyof StoredSession)[]): Promise<void>;
    destroy(): Promise<void>;
}
