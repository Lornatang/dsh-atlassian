import * as React from 'react'

const h = React.createElement
const prefix = '/plugins/atlassian'
const panelId = 'jira-board'

interface ClientContext { get?(name: string): unknown; slots: { inject(name: string, callback: () => unknown): () => void; register(options: Record<string, unknown>, component: React.ComponentType<never>): unknown } }
interface EndpointSettings { jiraUrl: string; confluenceUrl: string; jiraCaFile: string; confluenceCaFile: string; allowInsecureHttp: boolean }
interface Snapshot {
  ok: boolean; status: 'idle' | 'connecting' | 'authorizing' | 'ready' | 'error'; error?: string
  authorizationUrl?: string; site?: string; siteMismatch?: boolean; toolCount: number; mode?: 'cloud' | 'server'
  board: { jql: string; limit: number; promptTemplate: string }
  configuration?: EndpointSettings
  server?: { jiraUrl: string; confluenceUrl: string; hasJiraCredential: boolean; hasConfluenceCredential: boolean; allowInsecureHttp: boolean }
}
interface Issue { key: string; summary: string; url?: string; projectKey?: string; projectName?: string; assignee?: string; status: { name: string; categoryKey: string } }
interface Board { issues: Issue[]; jql: string; site?: string; truncated: boolean; limit: number }
interface Transition { id: string; name: string; toName: string }
interface SessionApi {
  list?: { getSnapshot(): { current?: string } }
  scope?(id: string): { remote?: { session?: { prompt?: (request: Record<string, unknown>) => Promise<{ ok?: boolean; error?: { message?: string } } | undefined> } } }
}
interface WorkspaceApi { list?: { getSnapshot(): { items: Array<{ workspaceId: string; sessionIds: string[] }> } } }
interface UiWorkspaceApi { connectWorkspace?(id: string): Promise<string> }

const Context = React.createContext<ClientContext>({ slots: { inject: () => () => undefined, register: () => undefined } })
if (typeof document !== 'undefined') {
  const style = document.createElement('style')
  style.setAttribute('data-plugin-css', '@lornatang/dsh-atlassian')
  style.textContent = `
.dab-root{--dab-line:color-mix(in srgb,currentColor 14%,transparent);--dab-soft:color-mix(in srgb,currentColor 4%,transparent);--dab-softer:color-mix(in srgb,currentColor 2.5%,transparent);box-sizing:border-box;padding:24px 28px 36px;max-width:1120px;margin:0 auto;color:inherit;font-size:14px;line-height:1.5}
.dab-root *{box-sizing:border-box}.dab-settings{max-width:900px}.dab-root h2,.dab-root h3,.dab-root p{margin:0}.dab-root button,.dab-root input,.dab-root select{font:inherit}
.dab-hero{display:flex;align-items:flex-start;gap:15px;margin-bottom:24px}.dab-brand-icon,.dab-service-icon{display:grid;place-items:center;flex:none;border-radius:14px;background:rgba(79,125,244,.15);color:#7098ff}
.dab-brand-icon{width:46px;height:46px}.dab-brand-icon svg{width:24px;height:24px}.dab-hero-copy{flex:1;min-width:0}.dab-eyebrow{font-size:10px;font-weight:700;letter-spacing:.13em;text-transform:uppercase;opacity:.58;margin-bottom:3px!important}
.dab-title{font-size:23px;line-height:1.2;font-weight:700;letter-spacing:-.025em}.dab-subtitle{margin-top:6px!important;opacity:.68;font-size:13px;max-width:560px}.dab-mode{flex:none;padding:5px 9px;border:1px solid var(--dab-line);border-radius:999px;background:var(--dab-soft);font-size:10px;font-weight:700;letter-spacing:.035em;opacity:.8}
.dab-section-label{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:24px 0 10px;font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;opacity:.6}
.dab-status{display:flex;align-items:center;gap:14px;padding:16px 18px;border:1px solid var(--dab-line);border-radius:13px;background:var(--dab-softer)}.dab-status-icon{display:grid;place-items:center;width:34px;height:34px;flex:none;border-radius:10px;color:#7296fa;background:rgba(100,137,255,.14)}
.dab-status-icon.is-ready{color:#2dbb87;background:rgba(45,187,135,.14)}.dab-status-icon.is-error{color:#f47878;background:rgba(244,120,120,.14)}.dab-status-main{min-width:0;flex:1}.dab-status-title{font-weight:700;font-size:14px}.dab-status-note{opacity:.64;font-size:12px;margin-top:1px!important;overflow-wrap:anywhere}.dab-status-count{padding-left:18px;border-left:1px solid var(--dab-line);text-align:right;white-space:nowrap}.dab-status-count strong{display:block;font-size:17px;line-height:1.1}.dab-status-count span{font-size:10px;text-transform:uppercase;letter-spacing:.07em;opacity:.58}
.dab-service{border:1px solid var(--dab-line);border-radius:14px;background:var(--dab-softer);padding:18px;margin-bottom:12px}.dab-service-head{display:flex;align-items:center;gap:11px;margin-bottom:16px}.dab-service-icon{width:37px;height:37px;border-radius:11px;font-size:15px;font-weight:800}.dab-service-icon.is-confluence{background:rgba(92,158,230,.15);color:#70b5f5}.dab-service-title{font-size:14px;font-weight:700;line-height:1.25}.dab-service-url{font-size:12px;opacity:.62;overflow-wrap:anywhere}.dab-service-copy{min-width:0;flex:1}.dab-service-tag{font-size:10px;font-weight:700;letter-spacing:.05em;opacity:.52;text-transform:uppercase}
.dab-config-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:15px}.dab-config-head p{font-size:12px;opacity:.65;margin-top:3px!important}.dab-advanced{margin-top:14px;font-size:12px}.dab-advanced summary{cursor:pointer;font-weight:650;opacity:.75;list-style-position:inside}.dab-advanced-body{padding-top:12px}.dab-checkbox{display:flex;align-items:flex-start;gap:8px;margin-top:13px;line-height:1.4}.dab-checkbox input{accent-color:#5984f3;margin-top:2px}.dab-config-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:15px}.dab-config-hint{font-size:12px;opacity:.62}
.dab-field-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.dab-field{display:block;min-width:0;font-size:12px;font-weight:650}.dab-field span{display:block;margin-bottom:6px}.dab-input{width:100%;min-width:0;min-height:39px;padding:8px 11px;border:1px solid var(--dab-line);border-radius:9px;background:var(--dab-soft);color:inherit;outline:none;transition:border-color .15s,box-shadow .15s}.dab-input::placeholder{color:inherit;opacity:.42}.dab-input:focus{border-color:#7196ff;box-shadow:0 0 0 3px rgba(104,145,255,.17)}
.dab-help{font-size:12px;opacity:.62;margin-top:11px!important}.dab-callout{display:flex;gap:9px;align-items:flex-start;padding:11px 12px;border-radius:9px;background:rgba(226,161,40,.11);color:color-mix(in srgb,currentColor 45%,#e8a82e);font-size:12px;margin-top:13px}.dab-callout svg{width:15px;height:15px;flex:none;margin-top:1px}
.dab-alert{padding:11px 13px;border:1px solid rgba(230,89,89,.3);border-radius:10px;background:rgba(230,89,89,.09);color:color-mix(in srgb,currentColor 40%,#ed6969);white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;margin-top:14px!important}.dab-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:18px}.dab-action-note{font-size:12px;opacity:.58;margin-left:auto}.dab-button{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:36px;padding:7px 13px;border:1px solid var(--dab-line);border-radius:9px;background:var(--dab-soft);color:inherit;font-weight:600;cursor:pointer;transition:background .15s,border-color .15s,transform .15s}.dab-button:hover:not(:disabled){background:color-mix(in srgb,currentColor 9%,transparent)}.dab-button:focus-visible{outline:2px solid #7196ff;outline-offset:2px}.dab-button:disabled{opacity:.4;cursor:not-allowed}.dab-button-primary{border-color:#4678ed;background:#4678ed;color:#fff}.dab-button-primary:hover:not(:disabled){background:#356be0;border-color:#356be0}.dab-button svg{width:15px;height:15px;flex:none}
.dab-link{color:#779bff;text-decoration:none;font-weight:600}.dab-link:hover{text-decoration:underline}.dab-cloud-card{padding:18px;border:1px solid var(--dab-line);border-radius:14px;background:var(--dab-softer)}.dab-cloud-card strong{display:block;margin-bottom:5px}.dab-cloud-card p{font-size:13px;opacity:.68}
.dab-board-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:20px}.dab-row{display:flex;gap:9px;align-items:center;flex-wrap:wrap;margin:10px 0}.dab-toolbar{display:flex;gap:9px;align-items:center;flex-wrap:wrap}.dab-search{flex:1;min-width:180px}.dab-project{width:auto;min-width:140px}.dab-query{display:flex;gap:9px;align-items:center;margin:10px 0 16px;padding:10px 12px;border:1px solid var(--dab-line);border-radius:10px;background:var(--dab-softer)}.dab-query label{font-size:11px;font-weight:800;letter-spacing:.06em;opacity:.65}.dab-query .dab-input{border:0;background:transparent;min-height:32px;padding:4px 6px;flex:1}.dab-query .dab-input:focus{box-shadow:none}.dab-selection{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;margin:0 0 16px;border:1px solid rgba(105,145,255,.3);border-radius:10px;background:rgba(105,145,255,.08)}.dab-selection-count{font-size:12px;font-weight:700;margin-right:5px}
.dab-columns{display:flex;align-items:flex-start;gap:12px;overflow-x:auto;padding-bottom:12px}.dab-column{min-width:230px;flex:1;border:1px solid var(--dab-line);border-radius:12px;background:var(--dab-softer);padding:10px}.dab-column-head{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:3px 3px 9px;font-size:12px;font-weight:700}.dab-column-count{font-size:11px;font-weight:600;opacity:.6}.dab-issue{border:1px solid var(--dab-line);border-radius:10px;background:var(--dab-soft);padding:11px;margin:0 0 8px;cursor:pointer;transition:border-color .15s,transform .15s}.dab-issue:hover{border-color:rgba(105,145,255,.5);transform:translateY(-1px)}.dab-issue:focus-visible{outline:2px solid #7196ff;outline-offset:2px}.dab-issue-key{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:700;color:#7a9cff}.dab-issue-key input{accent-color:#5984f3}.dab-issue-summary{font-weight:600;font-size:13px;line-height:1.4;margin-top:7px}.dab-issue-meta{display:block;margin-top:8px;font-size:11px;opacity:.6}.dab-empty{padding:36px 18px;text-align:center;border:1px dashed var(--dab-line);border-radius:12px;opacity:.65;font-size:13px}
.dab-detail{position:fixed;right:0;top:0;bottom:0;width:min(520px,90vw);overflow:auto;background:var(--dab-detail-bg,Canvas);color:CanvasText;border-left:1px solid var(--dab-line);padding:22px;z-index:50;box-shadow:0 0 24px #0004}.dab-detail-head{display:flex;justify-content:space-between;align-items:center;gap:12px}.dab-detail pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;opacity:.85;margin:18px 0}.dab-message{font-size:13px;opacity:.8;margin:10px 0!important}.dab-root svg{display:block}
@media(max-width:640px){.dab-root{padding:18px 16px 28px}.dab-hero{gap:11px}.dab-mode{display:none}.dab-field-grid{grid-template-columns:1fr}.dab-status-count{padding-left:10px}.dab-action-note{width:100%;margin-left:0}.dab-board-head{display:block}.dab-toolbar>*{min-width:0}.dab-project{flex:1}}
`
  document.head.appendChild(style)
}

async function api<T>(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(prefix + path, { method, cache: 'no-store', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
  const value = await response.json() as Record<string, unknown>
  if (!response.ok || value['ok'] === false) throw new Error(typeof value['error'] === 'string' ? value['error'] : `HTTP ${String(response.status)}`)
  return value as T
}
function useSnapshot(): { value?: Snapshot; error: string; refresh: () => Promise<void> } {
  const [value, setValue] = React.useState<Snapshot>()
  const [error, setError] = React.useState('')
  const refresh = React.useCallback(async () => {
    try { setValue(await api<Snapshot>('/status')); setError('') } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }, [])
  React.useEffect(() => { void refresh(); const timer = window.setInterval(() => { void refresh() }, 5000); return () => window.clearInterval(timer) }, [refresh])
  return { value, error, refresh }
}
function icon(name: 'link' | 'check' | 'alert' | 'arrow' | 'refresh' | 'external' | 'close'): React.ReactElement {
  const paths: Record<typeof name, string> = {
    link: 'M10 13a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.7 1.7M14 11a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.7-1.7',
    check: 'M5 12l4.5 4.5L19 7', alert: 'M12 8v4m0 4h.01M10.3 3.8 2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.8a2 2 0 0 0-3.4 0Z',
    arrow: 'M5 12h14m-6-6 6 6-6 6', refresh: 'M20 7v5h-5M4 17v-5h5M5.6 9a7 7 0 0 1 11.6-2L20 12M4 12l2.8 5a7 7 0 0 0 11.6-2',
    external: 'M14 4h6v6M20 4l-9 9M19 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5', close: 'M6 6l12 12M18 6 6 18',
  }
  return h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: paths[name] }))
}

function input(label: string, value: string, update: (value: string) => void, options: { password?: boolean; placeholder?: string } = {}): React.ReactElement {
  return h('label', { className: 'dab-field', key: label }, h('span', null, label),
    h('input', { className: 'dab-input', type: options.password ? 'password' : 'text', autoComplete: 'off', placeholder: options.placeholder, value, onChange: (event: React.ChangeEvent<HTMLInputElement>) => update(event.target.value) }))
}

export function AtlassianSettings(): React.ReactElement {
  const { value, error, refresh } = useSnapshot()
  const [busy, setBusy] = React.useState(false)
  const [failure, setFailure] = React.useState('')
  const [jiraUsername, setJiraUsername] = React.useState('')
  const [jiraSecret, setJiraSecret] = React.useState('')
  const [confluenceUsername, setConfluenceUsername] = React.useState('')
  const [confluenceSecret, setConfluenceSecret] = React.useState('')
  const [draft, setDraft] = React.useState<EndpointSettings>({ jiraUrl: '', confluenceUrl: '', jiraCaFile: '', confluenceCaFile: '', allowInsecureHttp: false })
  const [saving, setSaving] = React.useState(false)
  const applied = React.useRef('')
  const server = value?.server
  const isServer = value?.mode === 'server'
  const status = value?.status ?? 'loading'
  const statusLabels = { loading: 'Loading', idle: 'Not connected', connecting: 'Connecting', authorizing: 'Authorization required', ready: 'Connected', error: 'Connection failed' }
  const endpointKey = (item: EndpointSettings): string => JSON.stringify([item.jiraUrl, item.confluenceUrl, item.jiraCaFile, item.confluenceCaFile, item.allowInsecureHttp])
  React.useEffect(() => {
    const next = value?.configuration
    if (!next) return
    const key = endpointKey(next)
    if (applied.current !== key) { applied.current = key; setDraft(next) }
  }, [value?.configuration])
  const dirty = !!value?.configuration && endpointKey(draft) !== endpointKey(value.configuration)
  const save = async (): Promise<void> => {
    setSaving(true); setFailure('')
    try { await api('/configure', 'POST', draft); await refresh() }
    catch (err) { setFailure(err instanceof Error ? err.message : String(err)) }
    finally { setSaving(false) }
  }
  const act = async (action: 'connect' | 'disconnect'): Promise<void> => {
    setBusy(true); setFailure('')
    try {
      const payload = action === 'connect' && value?.mode === 'server' ? { jiraUsername, jiraSecret, confluenceUsername, confluenceSecret } : undefined
      const result = await api<Snapshot>(`/${action}`, 'POST', payload)
      if (result.status === 'ready' || action === 'disconnect') { setJiraSecret(''); setConfluenceSecret('') }
    } catch (err) { setFailure(err instanceof Error ? err.message : String(err)) }
    finally { await refresh(); setBusy(false) }
  }
  const service = (name: 'Jira' | 'Confluence', url: string, saved: boolean, username: string, setUsername: (text: string) => void, secret: string, setSecret: (text: string) => void): React.ReactElement =>
    h('section', { className: 'dab-service', key: name, 'aria-label': `${name} credentials` },
      h('div', { className: 'dab-service-head' },
        h('div', { className: `dab-service-icon${name === 'Confluence' ? ' is-confluence' : ''}`, 'aria-hidden': true }, name[0]),
        h('div', { className: 'dab-service-copy' }, h('h3', { className: 'dab-service-title' }, name), h('div', { className: 'dab-service-url' }, url)),
        h('span', { className: 'dab-service-tag' }, saved ? 'Saved' : 'Credentials')),
      h('div', { className: 'dab-field-grid' },
        input('Username', username, setUsername, { placeholder: 'Leave blank for a token' }),
        input('Password or token', secret, setSecret, { password: true, placeholder: saved ? 'Leave blank to keep saved value' : 'Enter password or token' })),
      h('p', { className: 'dab-help' }, 'Using a personal access token? Leave the username blank.'),
      url.startsWith('http:') ? h('div', { className: 'dab-callout' }, icon('alert'), h('span', null, 'This URL uses HTTP. Credentials and data are transmitted in plaintext.')) : null)
  return h('div', { className: 'dab-root dab-settings', 'data-dab-settings': '' },
    h('header', { className: 'dab-hero' }, h('div', { className: 'dab-brand-icon' }, icon('link')),
      h('div', { className: 'dab-hero-copy' }, h('p', { className: 'dab-eyebrow' }, 'Workspace integration'), h('h2', { className: 'dab-title' }, 'Atlassian'),
        h('p', { className: 'dab-subtitle' }, isServer ? 'Connect your self-hosted Jira or Confluence workspace.' : 'Bring your Atlassian Cloud workspace into your agent sessions.')),
      h('span', { className: 'dab-mode' }, isServer ? 'SERVER / DATA CENTER' : 'ATLASSIAN CLOUD')),
    h('div', { className: 'dab-section-label' }, 'Connection'),
    h('div', { className: 'dab-status', role: 'status', 'aria-live': 'polite' },
      h('div', { className: `dab-status-icon${status === 'ready' ? ' is-ready' : status === 'error' ? ' is-error' : ''}` }, icon(status === 'ready' ? 'check' : status === 'error' ? 'alert' : 'link')),
      h('div', { className: 'dab-status-main' }, h('div', { className: 'dab-status-title' }, statusLabels[status]),
        h('p', { className: 'dab-status-note' }, value?.site || (isServer ? 'Enter your credentials below to connect.' : 'Authorize your account to get started.'))),
      h('div', { className: 'dab-status-count' }, h('strong', null, String(value?.toolCount ?? 0)), h('span', null, 'Tools available'))),
    value?.configuration ? h('div', { className: 'dab-section-label' }, 'Service URLs') : null,
    value?.configuration ? h('section', { className: 'dab-service', 'aria-label': 'Service URLs' },
      h('div', { className: 'dab-config-head' }, h('div', null, h('h3', { className: 'dab-service-title' }, 'Choose where to connect'), h('p', null, 'Leave both blank for Atlassian Cloud. Add a URL for each self-hosted service you use.'))),
      h('div', { className: 'dab-field-grid' },
        input('Jira URL', draft.jiraUrl, (text) => setDraft((old) => ({ ...old, jiraUrl: text })), { placeholder: 'https://jira.example.com' }),
        input('Confluence URL', draft.confluenceUrl, (text) => setDraft((old) => ({ ...old, confluenceUrl: text })), { placeholder: 'https://confluence.example.com' })),
      h('details', { className: 'dab-advanced' }, h('summary', null, 'Advanced connection options'), h('div', { className: 'dab-advanced-body' },
        h('div', { className: 'dab-field-grid' },
          input('Jira CA file', draft.jiraCaFile, (text) => setDraft((old) => ({ ...old, jiraCaFile: text })), { placeholder: 'Optional PEM file path' }),
          input('Confluence CA file', draft.confluenceCaFile, (text) => setDraft((old) => ({ ...old, confluenceCaFile: text })), { placeholder: 'Optional PEM file path' })),
        h('label', { className: 'dab-checkbox' }, h('input', { type: 'checkbox', checked: draft.allowInsecureHttp, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft((old) => ({ ...old, allowInsecureHttp: event.target.checked })) }), h('span', null, 'Allow HTTP for self-hosted services (credentials and data are sent in plaintext).')))),
      [draft.jiraUrl, draft.confluenceUrl].some((url) => url.trim().startsWith('http:')) && !draft.allowInsecureHttp ? h('div', { className: 'dab-callout' }, icon('alert'), h('span', null, 'Use HTTPS or explicitly allow HTTP under advanced options.')) : null,
      h('div', { className: 'dab-config-actions' }, h('button', { type: 'button', className: 'dab-button', disabled: !dirty || saving || busy, onClick: () => { void save() } }, saving ? 'Saving…' : 'Save URLs'), h('span', { className: 'dab-config-hint' }, dirty ? 'Save changes before connecting.' : 'Changes apply to this DSH profile.'))) : null,
    isServer ? h('div', { className: 'dab-section-label' }, 'Services') : null,
    server?.jiraUrl ? service('Jira', server.jiraUrl, server.hasJiraCredential, jiraUsername, setJiraUsername, jiraSecret, setJiraSecret) : null,
    server?.confluenceUrl ? service('Confluence', server.confluenceUrl, server.hasConfluenceCredential, confluenceUsername, setConfluenceUsername, confluenceSecret, setConfluenceSecret) : null,
    isServer && !server?.jiraUrl && !server?.confluenceUrl ? h('div', { className: 'dab-cloud-card' }, h('strong', null, 'No services configured'), h('p', null, 'Add a Jira or Confluence URL to the profile configuration, then restart DSH.')) : null,
    !isServer ? h('div', { className: 'dab-cloud-card', style: { marginTop: 18 } }, h('strong', null, 'Connect with Atlassian'), h('p', null, 'Sign in securely in your browser and choose the access to grant.'), value?.authorizationUrl ? h('p', { style: { marginTop: 10 } }, h('a', { className: 'dab-link', href: value.authorizationUrl, target: '_blank', rel: 'noreferrer' }, 'Open authorization page')) : null) : null,
    value?.siteMismatch ? h('div', { className: 'dab-callout' }, icon('alert'), h('span', null, 'The authorized site does not match the configured expected site.')) : null,
    error || failure || value?.error ? h('p', { className: 'dab-alert', role: 'alert' }, failure || error || value?.error) : null,
    h('div', { className: 'dab-actions' },
      h('button', { type: 'button', className: 'dab-button dab-button-primary', disabled: busy || saving || dirty || (!isServer && value?.status === 'ready'), onClick: () => { void act('connect') } }, busy ? 'Connecting…' : value?.status === 'ready' ? 'Update connection' : 'Connect', icon('arrow')),
      h('button', { type: 'button', className: 'dab-button', disabled: busy || saving || value?.status === 'idle', onClick: () => { void act('disconnect') } }, 'Disconnect'),
      h('span', { className: 'dab-action-note' }, 'Credentials are stored locally.')),
  )
}

function promptFor(issues: Issue[], template: string): string {
  return issues.map((item) => template
    ? template.replaceAll('{{key}}', item.key).replaceAll('{{summary}}', item.summary)
    : `Work on Jira issue ${item.key}: ${item.summary}. Check the requirements and relevant code first, then report changes and verification. Do not change the Jira status automatically.`).join('\n\n')
}

export function JiraBoardPanel(): React.ReactElement {
  const ctx = React.useContext(Context)
  const { value: snapshot } = useSnapshot()
  const [board, setBoard] = React.useState<Board>()
  const [jql, setJql] = React.useState('')
  const [query, setQuery] = React.useState('')
  const [project, setProject] = React.useState('')
  const [selected, setSelected] = React.useState<string[]>([])
  const [detail, setDetail] = React.useState<{ issue: Issue; description: string; transitions: Transition[] }>()
  const [message, setMessage] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const refresh = React.useCallback(async (value: string) => {
    setLoading(true)
    try { const result = await api<Board>(`/board?jql=${encodeURIComponent(value)}`); setBoard(result); setJql(result.jql); setMessage('') }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setLoading(false) }
  }, [])
  React.useEffect(() => { if (snapshot?.status === 'ready') void refresh(snapshot.board.jql) }, [snapshot?.status, refresh])
  const issues = (board?.issues ?? []).filter((item) => (!project || item.projectKey === project) && `${item.key} ${item.summary} ${item.projectName ?? ''}`.toLowerCase().includes(query.toLowerCase()))
  const projects = [...new Set((board?.issues ?? []).map((item) => item.projectKey).filter((item): item is string => !!item))]
  const columns = [...new Set(issues.map((item) => item.status.name))]
  const selectedIssues = (board?.issues ?? []).filter((item) => selected.includes(item.key))
  const inspect = async (key: string): Promise<void> => {
    try {
      const [item, transitions] = await Promise.all([api<{ issue: Issue; description: string }>(`/issue/${encodeURIComponent(key)}`), api<{ transitions: Transition[] }>(`/issue/${encodeURIComponent(key)}/transitions`).catch(() => ({ transitions: [] }))])
      setDetail({ ...item, transitions: transitions.transitions })
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
  }
  const handoff = async (create: boolean): Promise<void> => {
    try {
      const sessions = ctx.get?.('sessions') as SessionApi | undefined
      let id = sessions?.list?.getSnapshot().current
      if (create) {
        const workspaces = ctx.get?.('workspaces') as WorkspaceApi | undefined
        const ui = ctx.get?.('uiWorkspace') as UiWorkspaceApi | undefined
        const items = workspaces?.list?.getSnapshot().items ?? []
        const workspace = items.find((item) => id && item.sessionIds.includes(id)) ?? items[0]
        id = workspace ? await ui?.connectWorkspace?.(workspace.workspaceId) : undefined
      }
      const send = id ? sessions?.scope?.(id)?.remote?.session?.prompt : undefined
      if (!id || !send) throw new Error('No session is available. Open a workspace first.')
      const requestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
      const result = await send({ requestId, sessionId: id, mode: 'queue', content: [{ type: 'text', text: promptFor(selectedIssues, snapshot?.board.promptTemplate ?? '') }], clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
      if (result?.ok === false) throw new Error(result.error?.message || 'Handoff failed')
      setMessage(`Sent ${String(selectedIssues.length)} issue(s)`)
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
  }
  return h('div', { className: 'dab-root', 'data-dsh-jira-board': '' },
    h('header', { className: 'dab-board-head' }, h('div', null, h('p', { className: 'dab-eyebrow' }, 'Your workspace'), h('h2', { className: 'dab-title' }, 'Jira board'), h('p', { className: 'dab-subtitle' }, board?.site ?? snapshot?.site ?? 'Your issues, all in one place.'))),
    h('div', { className: 'dab-toolbar' }, h('input', { className: 'dab-input dab-search', 'aria-label': 'Search issues', placeholder: 'Search by key or title', value: query, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setQuery(event.target.value) }),
      h('select', { className: 'dab-input dab-project', 'aria-label': 'Filter by project', value: project, onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setProject(event.target.value) }, h('option', { value: '' }, 'All projects'), ...projects.map((key) => h('option', { key, value: key }, key))),
      h('button', { className: 'dab-button', disabled: loading, onClick: () => { void refresh(jql) } }, icon('refresh'), loading ? 'Refreshing…' : 'Refresh')),
    h('form', { className: 'dab-query', onSubmit: (event: React.FormEvent) => { event.preventDefault(); void refresh(jql) } }, h('label', { htmlFor: 'dab-jql' }, 'JQL'), h('input', { id: 'dab-jql', className: 'dab-input', value: jql, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setJql(event.target.value) }), h('button', { className: 'dab-button', type: 'submit' }, 'Search')),
    selectedIssues.length ? h('div', { className: 'dab-selection' }, h('span', { className: 'dab-selection-count' }, `${String(selectedIssues.length)} selected`),
      h('button', { className: 'dab-button', onClick: () => { void handoff(false) } }, 'Send to current session'),
      h('button', { className: 'dab-button', onClick: () => { void handoff(true) } }, 'Send to new session'),
      h('button', { className: 'dab-button', onClick: () => { void navigator.clipboard.writeText(promptFor(selectedIssues, snapshot?.board.promptTemplate ?? '')).then(() => setMessage('Prompt copied')).catch(() => setMessage('Could not copy the prompt')) } }, 'Copy prompt'),
      h('button', { className: 'dab-button', onClick: () => setSelected([]) }, 'Clear selection')) : null,
    message ? h('p', { className: 'dab-message', role: 'status' }, message) : null,
    issues.length ? h('div', { className: 'dab-columns' }, ...columns.map((column) => {
      const columnIssues = issues.filter((item) => item.status.name === column)
      return h('section', { key: column, className: 'dab-column' }, h('div', { className: 'dab-column-head' }, h('span', null, column), h('span', { className: 'dab-column-count' }, String(columnIssues.length))),
        ...columnIssues.map((item) => h('div', { key: item.key, className: 'dab-issue', 'data-dsh-jira-card': '', role: 'button', tabIndex: 0, onClick: () => { void inspect(item.key) }, onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); void inspect(item.key) } } },
          h('label', { className: 'dab-issue-key', onClick: (event: React.MouseEvent) => event.stopPropagation() }, h('input', { type: 'checkbox', 'aria-label': `Select ${item.key}`, checked: selected.includes(item.key), onChange: (event: React.ChangeEvent<HTMLInputElement>) => setSelected(event.target.checked ? [...selected, item.key] : selected.filter((key) => key !== item.key)) }), item.key),
          h('div', { className: 'dab-issue-summary' }, item.summary), h('small', { className: 'dab-issue-meta' }, item.projectName ?? item.projectKey ?? ''))))
    })) : h('div', { className: 'dab-empty' }, snapshot?.status === 'ready' ? 'No issues match this view.' : 'Connect Atlassian in Settings to see your Jira issues.'),
    board?.truncated ? h('p', { className: 'dab-message' }, `Showing up to ${String(board.limit)} issues. Narrow the query for more.`) : null,
    detail ? h('aside', { className: 'dab-detail', 'aria-label': 'Issue details' }, h('div', { className: 'dab-detail-head' }, h('span', { className: 'dab-eyebrow' }, 'Issue details'), h('button', { className: 'dab-button', onClick: () => setDetail(undefined) }, icon('close'), 'Close')),
      h('h3', { className: 'dab-title', style: { fontSize: 19, marginTop: 16 } }, detail.issue.key, ' ', detail.issue.summary), detail.issue.url ? h('p', { style: { marginTop: 8 } }, h('a', { className: 'dab-link', href: detail.issue.url, target: '_blank', rel: 'noreferrer' }, 'Open in Jira')) : null,
      h('pre', null, detail.description), h('div', { className: 'dab-row' }, ...detail.transitions.map((transition) => h('button', { key: transition.id, className: 'dab-button', onClick: () => { void api('/transition', 'POST', { key: detail.issue.key, transitionId: transition.id }).then(() => { setDetail(undefined); return refresh(jql) }).catch((error: unknown) => setMessage(error instanceof Error ? error.message : String(error))) } }, transition.toName || transition.name)))) : null,
  )
}

export function BoardPanelIcon(): React.ReactElement {
  return h('svg', { viewBox: '0 0 24 24', width: 19, height: 19, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 3 }), h('path', { d: 'M9 4v16M15 4v16M5.8 8h.4M11.8 8h.4M17.8 8h.4' }))
}
export const name = '@lornatang/dsh-atlassian'
export const inject = ['slots']
export function apply(ctx: ClientContext): void {
  const wrap = (component: React.ComponentType<never>): React.ComponentType<never> => {
    const Wrapped = (props: Record<string, unknown>): React.ReactElement => h(Context.Provider, { value: ctx }, h(component as React.ComponentType<Record<string, unknown>>, props))
    return Wrapped as unknown as React.ComponentType<never>
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'atlassian', order: 30, label: 'Atlassian' }, wrap(AtlassianSettings as React.ComponentType<never>)))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: panelId, order: 40, label: 'Jira' }, wrap(BoardPanelIcon as React.ComponentType<never>)))
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: panelId }, wrap(JiraBoardPanel as React.ComponentType<never>)))
}
