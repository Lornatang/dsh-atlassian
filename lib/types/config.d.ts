import z from '@deepseek-ai/schemastery';
export declare const DEFAULT_CLOUD_URL = "https://mcp.atlassian.com/v1/mcp";
export interface ServerConfig {
    jiraUrl: string;
    confluenceUrl: string;
    jiraCaFile: string;
    confluenceCaFile: string;
    allowInsecureHttp: boolean;
}
export interface BoardConfig {
    jql: string;
    limit: number;
    timeoutMs: number;
    promptTemplate: string;
}
export interface Config {
    mode: 'cloud' | 'server';
    server: ServerConfig;
    serverName: string;
    url: string;
    redirectPort: number;
    toolCallTimeoutMs: number;
    expectedSite: string;
    authorizationTimeoutMs: number;
    autoOpenBrowser: boolean;
    board: BoardConfig;
}
/** Validate connection settings before persisting them to the DSH profile. */
export declare function configureEndpoints(current: Config, input: Record<string, unknown>): Config;
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    mode: z<"cloud" | "server", "cloud" | "server", "defined">;
    serverName: z<string, string, "defined">;
    url: z<string, string, "defined">;
    redirectPort: z<number, number, "defined">;
    toolCallTimeoutMs: z<number, number, "defined">;
    expectedSite: z<string, string, "defined">;
    authorizationTimeoutMs: z<number, number, "defined">;
    autoOpenBrowser: z<boolean, boolean, "defined">;
    server: z<Schemastery.ObjectS<NoInfer<{
        jiraUrl: z<string, string, "defined">;
        confluenceUrl: z<string, string, "defined">;
        jiraCaFile: z<string, string, "defined">;
        confluenceCaFile: z<string, string, "defined">;
        allowInsecureHttp: z<boolean, boolean, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        jiraUrl: z<string, string, "defined">;
        confluenceUrl: z<string, string, "defined">;
        jiraCaFile: z<string, string, "defined">;
        confluenceCaFile: z<string, string, "defined">;
        allowInsecureHttp: z<boolean, boolean, "defined">;
    }>>, "plain">;
    board: z<Schemastery.ObjectS<NoInfer<{
        jql: z<string, string, "defined">;
        limit: z<number, number, "defined">;
        timeoutMs: z<number, number, "defined">;
        promptTemplate: z<string, string, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        jql: z<string, string, "defined">;
        limit: z<number, number, "defined">;
        timeoutMs: z<number, number, "defined">;
        promptTemplate: z<string, string, "defined">;
    }>>, "plain">;
}>>, Schemastery.ObjectT<NoInfer<{
    mode: z<"cloud" | "server", "cloud" | "server", "defined">;
    serverName: z<string, string, "defined">;
    url: z<string, string, "defined">;
    redirectPort: z<number, number, "defined">;
    toolCallTimeoutMs: z<number, number, "defined">;
    expectedSite: z<string, string, "defined">;
    authorizationTimeoutMs: z<number, number, "defined">;
    autoOpenBrowser: z<boolean, boolean, "defined">;
    server: z<Schemastery.ObjectS<NoInfer<{
        jiraUrl: z<string, string, "defined">;
        confluenceUrl: z<string, string, "defined">;
        jiraCaFile: z<string, string, "defined">;
        confluenceCaFile: z<string, string, "defined">;
        allowInsecureHttp: z<boolean, boolean, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        jiraUrl: z<string, string, "defined">;
        confluenceUrl: z<string, string, "defined">;
        jiraCaFile: z<string, string, "defined">;
        confluenceCaFile: z<string, string, "defined">;
        allowInsecureHttp: z<boolean, boolean, "defined">;
    }>>, "plain">;
    board: z<Schemastery.ObjectS<NoInfer<{
        jql: z<string, string, "defined">;
        limit: z<number, number, "defined">;
        timeoutMs: z<number, number, "defined">;
        promptTemplate: z<string, string, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        jql: z<string, string, "defined">;
        limit: z<number, number, "defined">;
        timeoutMs: z<number, number, "defined">;
        promptTemplate: z<string, string, "defined">;
    }>>, "plain">;
}>>, "plain">;
