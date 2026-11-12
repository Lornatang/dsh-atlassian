import { AtlassianBridge } from './bridge.js';
import { ServerBridge } from './server-bridge.js';
import { createBoard } from './board.js';
import { Config, configureEndpoints } from './config.js';
import { registerRoutes } from './routes.js';
import { SessionStore, sessionFileFor } from './store.js';
export const name = 'atlassian';
export const inject = ['tools'];
export { Config };
export function apply(ctx, config) {
    const scope = ctx;
    const identity = config.mode === 'server' ? `server:${config.server.jiraUrl}\0${config.server.confluenceUrl}` : config.url;
    const store = new SessionStore(sessionFileFor(config.serverName, identity, scope.profileContext?.patchPath));
    const host = { register: (definition) => ctx.tools.register(definition), logger: ctx.logger };
    const bridge = config.mode === 'server'
        ? new ServerBridge(host, { serverName: config.serverName, server: config.server, store, timeoutMs: config.toolCallTimeoutMs })
        : new AtlassianBridge(host, { serverName: config.serverName, url: config.url, redirectPort: config.redirectPort, toolCallTimeoutMs: config.toolCallTimeoutMs, expectedSite: config.expectedSite, authorizationTimeoutMs: config.authorizationTimeoutMs, autoOpenBrowser: config.autoOpenBrowser, store });
    const board = createBoard(bridge);
    const connection = {
        snapshot: () => ({ ...config.server }),
        update: async (input) => {
            configureEndpoints(config, input);
            const editor = scope.get('configEditor');
            const entry = editor?.entries().find((candidate) => candidate.options.id === 'atlassian');
            if (!editor || !entry)
                throw new Error('DSH configuration editor is unavailable');
            await editor.edit(entry, (current) => configureEndpoints(Config(current), input));
        },
    };
    ctx.effect(() => () => bridge.dispose(), 'atlassian:connection');
    ctx.effect(() => {
        let dispose;
        let secured = false;
        const bind = () => {
            const web = (scope.get('webServer') ?? scope.get('httpServer'));
            if (!web)
                return;
            const fence = scope.get('connection');
            if (dispose && (secured || !fence))
                return;
            dispose?.();
            dispose = registerRoutes(web, bridge, board, config.board, fence, connection);
            secured = !!fence;
        };
        bind();
        const off = scope.on?.('internal/service', bind);
        return () => { off?.(); dispose?.(); };
    }, 'atlassian:routes');
    void bridge.start().catch((error) => ctx.logger.error(`atlassian: ${String(error)}`));
}
