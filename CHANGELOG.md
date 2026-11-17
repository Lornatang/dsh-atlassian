# Changelog

## 0.1.11 - 2026-11-17

- Invalidate the cached Jira site whenever the connection is replaced and deduplicate concurrent site lookups, so a reconnect can never serve data from the previous site.
- Reuse keep-alive connections for self-hosted REST requests and close the socket pool on reconnect, disconnect, and disposal.
- Scan Cloud SSE size limits with native buffer searches instead of a per-byte loop, and wake connection waiters on state changes instead of polling.
- Share one status poller between the settings and board client panels and skip re-renders when the snapshot is unchanged.
- Show a clear empty state on the Jira board for Confluence-only profiles instead of a missing-tool error.
- Expand issue keys and summaries literally in board handoff prompts.
- Destroy stored credentials when a configuration change points the profile at a different endpoint identity.
- Reject malformed request URLs and issue-key encodings with 400 responses, and bound request-body reads with a deadline.
- Bound the cross-process refresh lock even when toolCallTimeoutMs is configured very large.
- Include a GitHub release archive; this release is also published to npm.

## 0.1.10 - 2026-11-15

- Coordinate OAuth token rotation across processes sharing a profile, including delayed responses, shutdown, callback-port changes, and concurrent session updates.
- Include a GitHub release archive; npm is not published for this release.

## 0.1.8 - 2026-11-15

- Serialize rotating OAuth refreshes across concurrent MCP requests, preserve newer credentials after delayed responses, and cancel refreshes on disconnect.
- Include a GitHub release archive; npm is not published for this release.

## 0.1.7 - 2026-11-15

- Rewrite the README to the package-bundle documentation convention and add a
  Chinese translation; the package now ships `README.md` and `README.zh.md`.
- Publish `cordis.patch.yml` through the package `exports` map and include the
  Chinese README in the published files.
- Accept the bilingual language switcher in the documentation language check.

## 0.1.6

- Allow any DSH version in the package metadata and run integration checks against the selected host.

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
