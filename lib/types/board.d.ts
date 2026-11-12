export interface ToolBridge {
    rawNameMatching(pattern: RegExp): string | undefined;
    callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<readonly unknown[]>;
    snapshot?(): {
        status: string;
        error?: string | undefined;
    };
}
export interface BoardStatus {
    name: string;
    categoryKey: string;
    categoryName: string;
    colorName: string;
}
export interface BoardIssue {
    key: string;
    id: string;
    summary: string;
    status: BoardStatus;
    type: string;
    priority?: string | undefined;
    assignee?: string | undefined;
    reporter?: string | undefined;
    updated?: string | undefined;
    projectKey?: string | undefined;
    projectName?: string | undefined;
    url?: string | undefined;
}
export interface BoardTransition {
    id: string;
    name: string;
    toName: string;
    toCategoryKey: string;
}
export interface BoardProject {
    key: string;
    name: string;
}
export interface BoardIssueDetail {
    issue: BoardIssue;
    description: string;
}
export interface BoardPayload {
    issues: readonly BoardIssue[];
    constrained: boolean;
    jql: string;
    site: string | undefined;
    cloudId: string | undefined;
    truncated: boolean;
    limit: number;
}
export interface BoardQuery {
    jql?: string | undefined;
    limit: number;
    timeoutMs: number;
}
export declare class BoardError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare class JiraBoard {
    #private;
    constructor(bridge: ToolBridge);
    available(): boolean;
    get site(): string | undefined;
    cloudId(): Promise<string>;
    load(query: BoardQuery): Promise<BoardPayload>;
    detail(key: string, timeoutMs: number): Promise<BoardIssueDetail>;
    transitions(key: string, timeoutMs: number): Promise<readonly BoardTransition[]>;
    transition(key: string, transitionId: string, timeoutMs: number): Promise<void>;
    projects(timeoutMs: number): Promise<readonly BoardProject[]>;
}
export declare function createBoard(bridge: ToolBridge): JiraBoard;
