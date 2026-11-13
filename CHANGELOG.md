# Changelog

## 0.1.5

- Rename the package to `@lornatang/dsh-atlassian`, retaining existing profile
  settings and stored credentials when migrating from the previous package.
- Limit Cloud response bodies and individual streaming events to prevent
  excessive memory use from oversized responses.

## 0.1.4

- Keep the README focused on installation and everyday use, and remove an
  unavailable release download link.

## 0.1.3

- Support explicitly trusted self-signed server certificates in DSH Desktop
  while retaining certificate and hostname verification.
- Let users edit service URLs in Settings, with Atlassian Cloud selected when
  both URLs are blank.
- Refresh the English settings and Jira board interfaces for light and dark
  themes.

## 0.1.2

- Align the English README structure and configuration reference with the
  other DSH plugins.

## 0.1.1

- Add self-hosted Jira Server and Confluence Server/Data Center REST mode,
  with Basic or personal access token authentication and a Jira board.
- Verify TLS by default, allow a configured CA file, and require an explicit
  opt-in for HTTP endpoints.
- Restrict Cloud OAuth network requests to HTTPS and harden local credential
  file access.
- Provide an English interface and documentation.

## 0.1.0

- Connect DSH to the Atlassian remote MCP server with OAuth 2.1 and PKCE.
- Expose discovered tools to agents and provide a Jira board with issue details,
  filters, transitions and handoff to agent sessions.
- Isolate OAuth sessions by DSH profile, restrict local credential files, and
  require the DSH request fence for plugin endpoints.
- Provide prebuilt npm packaging and integration tests against DSH 0.2.2-rc.2.
