import type { BridgeHost, BridgeSnapshot } from './bridge.js';
import type { ServerConfig } from './config.js';
import { SessionStore } from './store.js';
type Args = Record<string, unknown>;
/** Direct REST bridge for older Jira Server and Confluence Server/Data Center. */
export declare class ServerBridge {
    #private;
    constructor(host: BridgeHost, options: {
        serverName: string;
        server: ServerConfig;
        store: SessionStore;
        timeoutMs: number;
    });
    snapshot(): BridgeSnapshot;
    rawNames(): readonly string[];
    rawNameMatching(pattern: RegExp): string | undefined;
    start(): Promise<void>;
    authorize(input?: Args): Promise<BridgeSnapshot>;
    disconnect(): Promise<BridgeSnapshot>;
    dispose(): Promise<void>;
    callTool(rawName: string, args: Args, timeoutMs?: number): Promise<readonly unknown[]>;
}
export {};
