---
description: "Atlassian Cloud OAuth and self-hosted Jira and Confluence REST inside a dsh profile: registered tools, an Atlassian settings section, and a Jira board panel."
kind: "package-bundle"
---

# @lornatang/dsh-atlassian

English | [中文](README.zh.md)

## Summary

`dsh-atlassian` connects a dsh profile to Atlassian Cloud or a self-hosted Jira and Confluence pair. Cloud mode holds an OAuth 2.1 session with the Atlassian remote MCP server and registers the tools it advertises for agent sessions; server mode registers a fixed REST tool set. It adds an Atlassian settings section and a Jira board panel to the Web client. Add or remove it with `dsh plugin --profile <name> add|remove @lornatang/dsh-atlassian`. The boundary: one connection per row, unencrypted credentials under the profile data directory, and a loopback OAuth callback.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The layer owns the Atlassian half of a profile: the Cloud OAuth session or the self-hosted REST clients, the credentials behind them, the tools they register, and the settings and board surfaces that drive them. The dsh host keeps the tool registry, the Web server and the client slot system; this package registers into them.

### Install into a profile

```text
dsh plugin --profile <name> add @lornatang/dsh-atlassian
dsh plugin --profile <name> remove @lornatang/dsh-atlassian
```

`add` composes the layer into the profile: the profile's `cordis.patch.yml` gains an insert entry with row id `atlassian`, package `@lornatang/dsh-atlassian`, and the five values the shipped patch carries — `mode: cloud`, `serverName: atlassian`, `url: https://mcp.atlassian.com/v1/mcp`, `redirectPort: 3334` and `autoOpenBrowser: true`. The manifest declares `dsh.bundle.patch: ./cordis.patch.yml`, which is the declaration the reconcile step reads; `remove` deletes the entry again. Restart DSH after either command, because the profile composes its rows and its client half only at startup, then open Settings → Atlassian. Releases before 0.1.5 published this package as `@lornatang/dsh-atlassian-bridge`; add the scoped name, remove the old package from the same profile and restart once — the row, its settings and the stored credentials survive.

Cloud mode starts connecting as soon as the plugin loads. With no saved session the MCP client returns an authorization error, the callback server binds `127.0.0.1:3334`, and the Settings section shows `Authorization required` with the authorization URL as a link; the wait is bounded by `authorizationTimeoutMs` (300000 ms by default). Approving in the browser completes the exchange, the tools register and the status becomes `Connected`. If the wait expires the status becomes `Connection failed` with `authorization timed out`, and Connect starts a new attempt and opens the browser when `autoOpenBrowser` is true. A busy callback port falls back to a free one, which clears the saved client registration, tokens and PKCE verifier, so the next start asks for authorization again.

Self-hosted mode starts connecting only when the store already holds credentials; otherwise the section shows the configured service URLs and one credential form per service and stays `Not connected`. Connect sends the username and password or token to the plugin, which checks `GET /rest/api/2/myself` on Jira and `GET /rest/api/user/current` on Confluence, saves the credentials to the profile store and registers the REST tools. Leave the username blank for a personal access token: the request then uses `Bearer <token>` instead of Basic authentication.

### What you get

In Cloud mode the tool surface is the remote server's catalog: every tool returned by the MCP `tools/list` call is registered as `mcp__<serverName>__<name>`, so with the default `serverName` the names read `mcp__atlassian__getJiraIssue`, `mcp__atlassian__searchJiraIssuesUsingJql` and so on — this package does not define that list, and the Atlassian MCP server owns the definitions. `publicToolName` replaces characters outside `[A-Za-z0-9_-]` with `_`; a name that changed or exceeds 64 characters is cut to 51 characters and suffixed with `_` plus twelve hex characters of the SHA-256 hash of the original name. The layer owns registration, the `toolCallTimeoutMs` deadline and rendering: text blocks are joined, and any other content block becomes `[<type> content]`.

In self-hosted mode `src/server-bridge.ts` registers fourteen fixed operations under the same `mcp__atlassian__<name>` convention: `getAccessibleAtlassianResources`, `searchJiraIssuesUsingJql`, `getJiraIssue`, `getVisibleJiraProjects`, `getTransitionsForJiraIssue`, `transitionJiraIssue`, `createJiraIssue`, `editJiraIssue`, `addCommentToJiraIssue`, `searchConfluenceUsingCql`, `getConfluencePage`, `getConfluenceSpaces`, `createConfluencePage` and `updateConfluencePage`.

The client half adds three rows, all owned and rendered by this package inside slots that the host supplies (`dsh.client.inject` names `@deepseek-ai/dsh-client-ui-slots` and `@deepseek-ai/dsh-client-ui-settings`):

- `settings.section`, id `atlassian`, order 30, label `Atlassian` — connection status, tool count, service URLs, credential forms, Connect and Disconnect.
- `sidebar.panellist`, id `jira-board`, order 40, label `Jira` — the sidebar icon that opens the board.
- `main`, key `jira-board` — the board itself: search, project filter, JQL form, one column per issue status, issue detail with transition buttons, and Send to current session / Send to new session / Copy prompt.

The routes behind those rows live at the fixed prefix `/plugins/atlassian` (`status`, `configure`, `connect`, `disconnect`, `debug-tools`, `board`, `projects`, `transition`, `issue/<key>`, `issue/<key>/transitions`). They answer only when the DSH `connection` service is present and its request fence admits the request; without the service the routes return 503.

### Configuration

The profile patch carries an `atlassian` row. The shipped layer inserts it with Cloud defaults, so a profile only writes the values it changes:

```yaml
# $DSH_HOME/profiles/<name>/cordis.patch.yml
- id: atlassian
  config:
    expectedSite: example.atlassian.net
    board:
      jql: 'project = DEMO ORDER BY updated DESC'
      limit: 25
      promptTemplate: 'Work on Jira issue {{key}}: {{summary}}'
```

`Config` is a schemastery schema defined in `src/config.ts` and exported from `src/index.ts`, so the defaults and ranges below are schema constraints; the `serverName` pattern is checked when the credential file name is built. Every accepted field:

| Field | Default | Meaning |
| --- | --- | --- |
| `mode` | `cloud` | `cloud` connects to the Atlassian remote MCP server; `server` uses the self-hosted REST bridge. Saving service URLs in Settings derives this value. |
| `serverName` | `atlassian` | Tool-name prefix (`mcp__<serverName>__…`) and the identity inside the credential file name; `[A-Za-z0-9_-]`, 1–64 characters. |
| `url` | `https://mcp.atlassian.com/v1/mcp` | Cloud MCP endpoint. HTTPS is required unless the URL is loopback HTTP. |
| `redirectPort` | `3334` | Loopback OAuth callback port, 0–65535; `0` binds a free port. |
| `toolCallTimeoutMs` | `60000` | Deadline for one tool call, minimum 1. |
| `expectedSite` | empty | When set, the settings section warns if the authorized site host differs. |
| `authorizationTimeoutMs` | `300000` | How long the layer waits for the OAuth callback, minimum 1000. |
| `autoOpenBrowser` | `true` | Open the authorization page in the browser when an authorization is required. |
| `server.jiraUrl` | empty | Self-hosted Jira base URL; an empty value disables Jira. |
| `server.confluenceUrl` | empty | Self-hosted Confluence base URL; an empty value disables Confluence. |
| `server.jiraCaFile` | empty | Optional PEM trust file added to the Node.js root certificates for Jira. |
| `server.confluenceCaFile` | empty | Optional PEM trust file added to the Node.js root certificates for Confluence. |
| `server.allowInsecureHttp` | `false` | Permit plain `http:` service URLs; credentials then travel in plaintext. |
| `board.jql` | empty | Initial JQL; an empty value uses `updated >= -180d ORDER BY updated DESC`. |
| `board.limit` | `50` | Issues per board load, 1–100. |
| `board.timeoutMs` | `90000` | Deadline for one board request, minimum 1000. |
| `board.promptTemplate` | empty | Handoff text where `{{key}}` and `{{summary}}` are replaced; an empty value uses the built-in prompt. |

Service URLs go through the same validation when they are saved in Settings: the value must be an HTTP(S) base URL without credentials, query or fragment, the trailing slash is dropped, and the row's `mode` becomes `server` as soon as either URL is non-empty — clearing both returns it to `cloud` and restores the official endpoint. Credentials never come from the patch; self-hosted usernames and secrets are entered in Settings and stored by the profile store.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The layer is a single patch row: an `insert` of `atlassian` carrying the Cloud defaults. The patch has no platform gate; the client half is declared in `package.json` (`dsh.client.platform: web`, with the two slot packages injected), so a headless profile loads the host half only and the settings and board rows appear in a Web profile.

`apply` selects the bridge from `mode` — `AtlassianBridge` for Cloud, `ServerBridge` for self-hosted — derives the credential identity (the configured URL for Cloud, `server:<jiraUrl>` and `<confluenceUrl>` joined by a NUL for self-hosted), builds a `SessionStore` for `sessionFileFor(serverName, identity, patchPath)`, creates the board, and registers the routes against `webServer` or `httpServer`. Every route sits behind the `connection` service's request fence; when the service appears after the plugin, an `internal/service` listener re-binds the routes. `void bridge.start()` runs in the background and logs failures.

The Cloud path uses OAuth 2.1 with PKCE through the MCP SDK: a callback server on `127.0.0.1:<redirectPort>` receives `/callback`, `createCloudFetch` rejects every non-HTTPS endpoint (loopback HTTP excepted) and caps response bodies and SSE events at 10 MiB, and after `connect` the bridge paginates `tools/list` (at most 100 pages and 1000 tools) and registers each definition. The site label comes from `getAccessibleAtlassianResources`.

The self-hosted path talks to one or two explicit REST endpoints over `node:https`: Basic authentication when a username exists, `Bearer` when only a secret is stored, and an optional additional CA with hostname and TLS verification still enabled. Responses are capped at 10 MiB, redirects and server error bodies are not followed or echoed, and the Jira and Confluence operations are fixed in `src/server-bridge.ts` — no discovery, resources or prompts.

The client half registers into `settings.section`, `sidebar.panellist` and `main`, polls `GET /status` every five seconds, and talks to the host only through `/plugins/atlassian`. Handoff reuses the client `sessions` service: the selected issues are rendered through `promptFor` (template with `{{key}}` and `{{summary}}`, or the built-in prompt) and queued into the current session or a newly connected workspace.

| Source | Contents |
| --- | --- |
| `cordis.patch.yml` | The layer itself: one insert entry, row id `atlassian`, Cloud defaults. |
| `src/index.ts` | `apply`: bridge selection, credential identity, tool host, route registration, background start. |
| `src/config.ts` | `Config` schema, defaults and `configureEndpoints` URL validation with mode derivation. |
| `src/bridge.ts` | Cloud MCP client, OAuth retry, tool naming, registration, calls and disconnect. |
| `src/server-bridge.ts` | Self-hosted bridge: credential checks, the fourteen REST operations and their tool definitions. |
| `src/server-http.ts` | One Jira or Confluence endpoint: Basic/Bearer headers, extra CA, timeouts, byte cap. |
| `src/oauth.ts` | PKCE provider, loopback callback server, HTTPS-only fetch wrapper, response size limits. |
| `src/store.ts` | Profile-scoped credential file: naming, ownership and symlink checks, atomic `0600` writes. |
| `src/board.ts` | `JiraBoard`: JQL search, site resolution, issue detail, transitions, projects. |
| `src/routes.ts` | `/plugins/atlassian` handlers behind the DSH request fence. |
| `src/open-url.ts` | Browser launch for the authorization page, HTTPS or loopback HTTP only. |
| `src/client/index.tsx` | Settings section, sidebar entry and board panel; calls the routes above. |
| `tests/*.test.mjs` | Bridge, configuration, security, server and browser suites. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [CHANGELOG.md](CHANGELOG.md) — release history, including the 0.1.5 rename and the 0.1.6 DSH version range.
- [LICENSE](LICENSE) — Apache-2.0.
- [NOTICE](NOTICE) — attribution notice shipped with the package.
- [DeepSeek Harness configuration catalog](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/config-catalog.md) — the deployment reference this row's `config` block follows.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the tool registry: once a connection is established the layer registers each Atlassian tool definition, so the tool's name, description and input schema reach the model as part of the request's tool list.

#### KV Cache effect

The tool list is part of the cached request prefix, so activation changes it: a disconnected profile sends no Atlassian tools, and a connected one sends every registered definition. In Cloud mode those definitions come from the remote `tools/list` response, so a catalog change on Atlassian's side changes the prefix at the next connection; the self-hosted set is fixed. The settings section and the board run over HTTP routes and add nothing to the request.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

These constraints describe what the layer does not bridge and where a profile has to work around it.

- **One connection per row** — one bridge instance and the fixed `/plugins/atlassian` route prefix mean the layer assumes one Cloud site or one self-hosted Jira/Confluence pair per profile; a second site needs a separate profile. The board additionally binds the first accessible resource and caches it for the process lifetime.
- **Self-hosted mode is a fixed subset** — it exposes the fourteen REST operations above instead of the Cloud MCP catalog, Confluence pages are storage-format XHTML, and an update must carry the current page version, which the layer reads immediately before writing.
- **Credentials are stored unencrypted** — one JSON file per profile and connection under `profiles/<name>/data/`, mode `0600` on POSIX with symlink and ownership checks; on Windows the profile directory ACL is the only protection, and a backup of that directory exposes the tokens.
- **The OAuth callback must stay reachable** — the browser and DSH must share the loopback host, and a DSH on another machine needs `redirectPort` forwarded to it. A busy port falls back to an ephemeral one, which clears the saved client registration, tokens and verifier and forces a new authorization.
- **Cloud endpoints must be HTTPS** — `createCloudFetch` rejects any non-HTTPS URL, including redirect targets, except a loopback `http:` MCP URL, so a plain-http endpoint on a remote host is refused.
- **Non-text tool output becomes placeholders** — content blocks other than text render as `[<type> content]`, and MCP resources and prompts are not bridged, so an attachment or image result reaches the model as a placeholder string.
- **Board loading is demand-driven** — the settings section polls `/status` every five seconds, but the board runs one JQL search per load (connect, search, refresh or transition), returns at most `board.limit` issues (1–100), and retries an unrestricted query once as `updated >= -180d ORDER BY updated DESC`.
- **Disconnect is local** — it deletes the stored credentials and unregisters the tools, but it does not revoke the grant at Atlassian; revoke that in the Atlassian account settings.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`npm run build` cleans `lib/`, compiles the host and client trees with `tsc`, then bundles `src/client/index.tsx` into `lib/client.js` with `scripts/bundle-client.mjs`. `npm test` runs that build and then `node --test tests/*.test.mjs`, which includes the Chrome-backed browser suite; `npm run typecheck` runs both `tsc --noEmit` passes. `npm run test:dsh` runs `scripts/verify-dsh.mjs`, which packs the plugin with `npm pack` and drives a real `dsh` binary (default `dsh`, overridable with `DSH_TEST_BINARY`) through profile creation, `plugin add`, the authenticated Web route, a self-hosted connect, a board load and `plugin remove`, then runs the browser check. The environment variables the script reads are `DSH_TEST_BINARY`, `DSH_TEST_MODE=server`, `DSH_TEST_UPGRADE_FROM=legacy-fixture`, `DSH_TEST_LANGUAGE` and `CHROME_PATH`.

`lib/` is committed and CI runs `git diff --exit-code -- lib`, so rebuild and include `lib/` with any source change. Node.js 22.19 or newer is required (`engines.node`), the peer dependency is `@deepseek-ai/cordis ~4.1.0`, and the optional `dsh-tools`/`dsh-llm` development dependencies track the `0.2.2-rc.2` DSH line. The stored file is `data/atlassian-bridge-<serverName>-<first 12 hex of sha256(identity)>.json` with `version: 1`; changing the identity computation or the file naming orphans saved credentials. `tests/language.test.mjs` scans `README.md`, `CHANGELOG.md`, `NOTICE`, `src/` and `lib/` for CJK characters, so English text belongs in `README.md` and Chinese only in `README.zh.md`.

</details>
