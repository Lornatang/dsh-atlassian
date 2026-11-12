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
/** Keep credentials separate for each DSH profile and server. */
export declare function sessionFileFor(serverName: string, url: string, patchPath?: string): string;
/** Serialize state changes and replace the file only after a complete write. */
export declare class SessionStore {
    #private;
    constructor(file: string);
    get file(): string;
    get current(): StoredSession;
    load(): Promise<StoredSession>;
    patch(patch: Partial<StoredSession>): Promise<void>;
    clear(...fields: readonly (keyof StoredSession)[]): Promise<void>;
    destroy(): Promise<void>;
}
