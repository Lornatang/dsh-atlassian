import * as React from 'react';
interface ClientContext {
    get?(name: string): unknown;
    slots: {
        inject(name: string, callback: () => unknown): () => void;
        register(options: Record<string, unknown>, component: React.ComponentType<never>): unknown;
    };
}
export declare function AtlassianSettings(): React.ReactElement;
export declare function JiraBoardPanel(): React.ReactElement;
export declare function BoardPanelIcon(): React.ReactElement;
export declare const name = "@lornatang/dsh-atlassian";
export declare const inject: string[];
export declare function apply(ctx: ClientContext): void;
export {};
