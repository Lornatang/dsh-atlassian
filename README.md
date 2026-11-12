# dsh-atlassian-bridge

Connect Atlassian Cloud or self-hosted Jira and Confluence to DeepSeek Harness
(DSH). The plugin exposes Atlassian tools to agent sessions and adds a Jira
board to the Web interface.

**Requires:** Node.js 22.19+, DSH 0.2.2-rc.2+, and a Web-compatible profile.
Installation and startup are tested with DSH 0.2.2-rc.2.

## Install

```bash
dsh plugin --profile web add @lornatang/dsh-atlassian-bridge
```

Restart DSH, or start the default Web profile with `dsh web --no-open`. For a
profile with another name, replace `web` in the install command. Use the same
command to update the plugin, then restart DSH; profile configuration is kept.

A prebuilt GitHub Release is also available:

```bash
dsh plugin --profile web add https://github.com/Lornatang/dsh-atlassian-bridge/releases/latest/download/dsh-atlassian-bridge.tgz
```

Avoid loading another integration that uses the same settings, routes or tool
names in the same profile. This community plugin is not an Atlassian or
DeepSeek product.

## Connect

Open **Settings → Atlassian**. Leave both service URLs blank to use the
official Atlassian Cloud endpoint, or enter the base URL of each self-hosted
service you want to use and select **Save URLs**. Then select **Connect**.
For Atlassian Cloud, sign in and approve the requested access. If a browser
does not open, use the connection link shown in Settings. Available tools appear as
`mcp__atlassian__…`; their permissions depend on the authorized account.

Open **Jira** in the sidebar to browse issues, search with JQL, inspect details
and transitions, or select issues to send to an agent session. The Cloud MCP
service may expose additional products, depending on Atlassian's service and
your account access.

The OAuth callback listens on `127.0.0.1` on the DSH host. If DSH runs on a
remote machine, forward the callback port so the browser can reach it. Keep the
port stable: changing it may require a new authorization.

## Configuration

Edit `~/.dsh/profiles/web/cordis.patch.yml` (or use `$DSH_HOME` in place of
`~/.dsh`) and add or edit the `atlassian` entry. Restart DSH after changes.
The default Cloud configuration is:

```yaml
- id: atlassian
  config:
    mode: cloud
    serverName: atlassian
    url: 'https://mcp.atlassian.com/v1/mcp'
    redirectPort: 3334
    expectedSite: ''
    toolCallTimeoutMs: 60000
    authorizationTimeoutMs: 300000
    autoOpenBrowser: true
    board:
      jql: ''
      limit: 50
      timeoutMs: 90000
      promptTemplate: ''
```

| Option | Default | Purpose |
| --- | --- | --- |
| `mode` | `cloud` | Select `cloud` or self-hosted `server` mode. |
| `serverName` | `atlassian` | Tool namespace and local credential-store identity. |
| `url` | Atlassian MCP URL | Cloud MCP endpoint; remote endpoints must use HTTPS. |
| `redirectPort` | `3334` | Loopback OAuth callback port; an occupied port falls back to a free port. |
| `expectedSite` | empty | Display a warning when the authorized Cloud site differs. |
| `toolCallTimeoutMs` | `60000` | Tool request timeout in milliseconds. |
| `authorizationTimeoutMs` | `300000` | Time allowed to complete OAuth authorization. |
| `autoOpenBrowser` | `true` | Open the Cloud authorization page automatically. |
| `board.jql` / `board.limit` | empty / `50` | Initial query and maximum issues per refresh; limit is 1–100. |
| `board.timeoutMs` | `90000` | Board request timeout in milliseconds. |
| `board.promptTemplate` | empty | Handoff text; supports `{{key}}` and `{{summary}}`. |

`expectedSite` is a warning, not an access restriction. An empty board query
uses the built-in view. An empty prompt template uses the default handoff text.
Cloud MCP and discovered OAuth endpoints require HTTPS; plain HTTP is allowed
only when the configured MCP server is on loopback for local development.

## Self-hosted Jira and Confluence

Enter one or both service base URLs in **Settings → Atlassian** and save them.
Include any context path used by your installation. A blank URL disables that
product when the other URL is filled; leaving both blank selects Cloud.

Alternatively, set `mode: server` and configure the profile patch directly:

```yaml
- id: atlassian
  config:
    mode: server
    server:
      jiraUrl: 'https://jira.example.com'
      confluenceUrl: 'https://confluence.example.com'
      jiraCaFile: ''
      confluenceCaFile: '/path/to/trusted-confluence-ca.pem'
      allowInsecureHttp: false
```

| Option | Default | Purpose |
| --- | --- | --- |
| `server.jiraUrl` / `server.confluenceUrl` | empty | Jira and Confluence base URLs; an empty value disables that product. |
| `server.jiraCaFile` / `server.confluenceCaFile` | empty | PEM trust file for a private or self-signed certificate. |
| `server.allowInsecureHttp` | `false` | Allow HTTP service URLs after explicitly accepting plaintext transport. |

Restart DSH and open **Settings → Atlassian**. Enter a username and password
for Basic authentication, or leave the username empty and enter a personal
access token for Bearer authentication. When both URLs are configured, provide
credentials for both services. Do not put passwords or tokens in the profile
patch or repository.

Jira Server versions before 8.14 do not include Atlassian's native personal
access tokens. They need an account and password or a separately installed
token mechanism. Confluence Server 7.9+ supports native personal access tokens
when enabled by its administrator.

Self-hosted mode supports Jira search, issue read/create/edit, comments,
projects and transitions; it also supports Confluence space listing, CQL
search, and page read/create/update. It does not expose every Cloud MCP tool.
Confluence page updates use storage-format XHTML and the current page version.

HTTPS certificates and hostnames are verified. For a private CA or self-signed
certificate, set the matching CA file under **Advanced connection options**
after checking its identity through a trusted channel. HTTP sends credentials and data in plaintext; use HTTPS or an
encrypted tunnel whenever possible. The Settings page also sends credentials
to the DSH host, so open it locally or over HTTPS.

## Permissions and data

The plugin uses the permissions of the Atlassian account you connect. Some
tools can change Jira or Confluence content; DSH's normal tool permissions
still apply. Cloud MCP resources and prompts are not bridged, and image results
are shown as text placeholders.

OAuth details and self-hosted credentials are stored as unencrypted JSON under
`~/.dsh/profiles/<name>/data/atlassian-bridge-*.json`. On POSIX systems the
file is restricted to its owner. On Windows, restrict the profile directory
with ACLs. Protect backups of these files and run only one DSH process per
profile to avoid concurrent session changes.

Disconnecting in Settings removes the local credentials and registered tools.
It does not revoke an Atlassian grant; revoke that separately in Atlassian when
needed.

## Troubleshooting

- **Cannot connect:** Check the configured service URL, account permissions,
  credentials and DSH log. Configure credentials for each enabled service.
- **Certificate verification fails:** Confirm the hostname and configure the
  appropriate trusted PEM file for a private certificate.
- **HTTP service is rejected:** Switch to HTTPS, or explicitly set
  `server.allowInsecureHttp: true` after accepting plaintext transport.
- **Cloud sign-in does not return to DSH:** Check the callback port and, for a
  remote DSH host, its SSH port forwarding. A changed port may require a new
  authorization.
- **Jira board is empty:** Check the connection and account permissions, then
  try a narrower JQL query or increase `board.limit` within its supported range.

## Uninstall

```bash
dsh plugin --profile web remove @lornatang/dsh-atlassian-bridge
```

Disconnect first to remove local credentials, then restart DSH after uninstall.
Otherwise, remove the corresponding `data/atlassian-bridge-*.json` file from
the stopped profile manually.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run test:dsh
```

The DSH integration test uses a temporary Web profile and local mock services.
It requires DSH 0.2.2-rc.2 and `pnpm` on `PATH`; Chrome is required in CI and
used locally when available. These tests do not modify a real Atlassian site.

[Apache-2.0](LICENSE)
