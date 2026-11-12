import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { type Logger } from './oauth.js';
import type { SessionStore } from './store.js';
export interface BridgeHost {
    register(definition: ToolDefinition): () => void;
    logger: Logger;
}
export interface BridgeOptions {
    serverName: string;
    url: string;
    redirectPort: number;
    toolCallTimeoutMs: number;
    expectedSite: string;
    authorizationTimeoutMs: number;
    autoOpenBrowser: boolean;
    store: SessionStore;
}
export type BridgeStatus = 'idle' | 'connecting' | 'authorizing' | 'ready' | 'error';
export interface BridgeSnapshot {
    status: BridgeStatus;
    authorizationUrl: string | undefined;
    site: string | undefined;
    siteMismatch: boolean;
    toolCount: number;
    error: string | undefined;
    mode?: 'cloud' | 'server';
    server?: {
        jiraUrl: string;
        confluenceUrl: string;
        hasJiraCredential: boolean;
        hasConfluenceCredential: boolean;
        allowInsecureHttp: boolean;
    };
}
export declare function publicToolName(server: string, tool: string): string;
export declare class AtlassianBridge {
    #private;
    constructor(host: BridgeHost, options: BridgeOptions);
    snapshot(): BridgeSnapshot;
    rawNames(): readonly string[];
    rawNameMatching(pattern: RegExp): string | undefined;
    start(): Promise<void>;
    authorize(): Promise<BridgeSnapshot>;
    callTool(rawName: string, args: Record<string, unknown>, timeoutMs?: number): Promise<readonly unknown[]>;
    disconnect(): Promise<BridgeSnapshot>;
    dispose(): Promise<void>;
}
