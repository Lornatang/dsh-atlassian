export interface JiraResource {
    readonly id: string;
    readonly base: string;
    readonly site: string;
}
export interface ConnectionResource extends JiraResource {
    readonly epoch: number;
}
export declare function decodeToolJson(content: unknown): unknown;
export declare function selectJiraResource(data: unknown, allowsHttp?: (url: URL) => boolean): JiraResource | undefined;
