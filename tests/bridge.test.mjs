import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { AtlassianBridge } from '../lib/bridge.js'
import { JiraBoard } from '../lib/board.js'
import { SessionStore } from '../lib/store.js'
import { startMockMcp } from './mock-mcp.mjs'

const logger = { info() {}, warn() {}, error() {} }
async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(25) }
  throw new Error('bridge did not become ready')
}

function childBridge(url, file, port) {
  const child = fork(fileURLToPath(new URL('./fixtures/cross-process-bridge.mjs', import.meta.url)), [url, file, String(port)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  const pending = new Map()
  let next = 0
  child.on('message', ({ id, result, error }) => {
    const task = pending.get(id)
    if (!task) return
    pending.delete(id)
    if (error) task.reject(new Error(error))
    else task.resolve(result)
  })
  child.on('exit', (code) => {
    for (const task of pending.values()) task.reject(new Error(`bridge child exited: ${code}`))
    pending.clear()
  })
  return {
    send(command) {
      return new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); child.send({ id, command }) })
    },
    kill() {
      return new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) { resolve(); return }
        child.once('exit', resolve)
        child.kill()
      })
    },
  }
}

for (const staleUnauthorizedDelay of [0, 300]) test(`independent processes share rotating credentials, delayed 401=${staleUnauthorizedDelay}`, async () => {
  const mock = await startMockMcp({ oauth: true, rotateRefresh: true, refreshDelay: 150, staleUnauthorizedDelay })
  const root = await mkdtemp(join(tmpdir(), 'atlassian-process-refresh-'))
  const file = join(root, 'session.json')
  const bridge = new AtlassianBridge({ logger, register() { return () => {} } }, {
    serverName: 'atlassian', url: mock.url, redirectPort: 0, toolCallTimeoutMs: 5000,
    expectedSite: '', authorizationTimeoutMs: 5000, autoOpenBrowser: false, store: new SessionStore(file),
  })
  let child
  try {
    await bridge.start()
    await waitFor(() => bridge.snapshot().status === 'authorizing')
    await fetch(bridge.snapshot().authorizationUrl)
    await waitFor(() => bridge.snapshot().status === 'ready')
    const before = JSON.parse(await readFile(file, 'utf8'))
    child = childBridge(mock.url, file, Number(new URL(before.redirectUri).port))
    const secondary = await child.send('start')
    assert.equal(secondary.status, 'ready')
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).tokens, before.tokens)
    mock.expire()
    await Promise.all([bridge.callTool('getJiraIssue', { issueIdOrKey: 'DEMO-1' }), child.send('call')])
    assert.equal(mock.refreshes(), 1)
    assert.equal(JSON.parse(await readFile(file, 'utf8')).tokens.refresh_token, 'rotated-refresh-1')
    await child.send('call')
  } finally {
    if (child) { await child.send('dispose').catch(() => {}); await child.kill() }
    await bridge.dispose()
    await mock.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('a stale process cannot restore credentials after another disconnects', async () => {
  const mock = await startMockMcp({ oauth: true, rotateRefresh: true })
  const root = await mkdtemp(join(tmpdir(), 'atlassian-process-disconnect-'))
  const file = join(root, 'session.json')
  const bridge = new AtlassianBridge({ logger, register() { return () => {} } }, {
    serverName: 'atlassian', url: mock.url, redirectPort: 0, toolCallTimeoutMs: 5000,
    expectedSite: '', authorizationTimeoutMs: 5000, autoOpenBrowser: false, store: new SessionStore(file),
  })
  let child
  try {
    await bridge.start()
    await waitFor(() => bridge.snapshot().status === 'authorizing')
    await fetch(bridge.snapshot().authorizationUrl)
    await waitFor(() => bridge.snapshot().status === 'ready')
    const saved = JSON.parse(await readFile(file, 'utf8'))
    child = childBridge(mock.url, file, Number(new URL(saved.redirectUri).port))
    assert.equal((await child.send('start')).status, 'ready')
    await bridge.disconnect()
    mock.expire()
    await assert.rejects(child.send('call'))
    await assert.rejects(stat(file), { code: 'ENOENT' })
    assert.equal(mock.refreshes(), 0)
  } finally {
    if (child) { await child.send('dispose').catch(() => {}); await child.kill() }
    await bridge.dispose()
    await mock.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('disposing a process waits for its already-sent refresh before another refreshes', async () => {
  const mock = await startMockMcp({ oauth: true, rotateRefresh: true, refreshDelay: 400 })
  const root = await mkdtemp(join(tmpdir(), 'atlassian-process-dispose-'))
  const file = join(root, 'session.json')
  const bridge = new AtlassianBridge({ logger, register() { return () => {} } }, {
    serverName: 'atlassian', url: mock.url, redirectPort: 0, toolCallTimeoutMs: 5000,
    expectedSite: '', authorizationTimeoutMs: 5000, autoOpenBrowser: false, store: new SessionStore(file),
  })
  let child
  try {
    await bridge.start()
    await waitFor(() => bridge.snapshot().status === 'authorizing')
    await fetch(bridge.snapshot().authorizationUrl)
    await waitFor(() => bridge.snapshot().status === 'ready')
    const saved = JSON.parse(await readFile(file, 'utf8'))
    child = childBridge(mock.url, file, Number(new URL(saved.redirectUri).port))
    assert.equal((await child.send('start')).status, 'ready')
    mock.expire()
    const first = bridge.callTool('getJiraIssue', { issueIdOrKey: 'DEMO-1' }).catch(() => undefined)
    await waitFor(() => mock.refreshes() === 1)
    const disposed = bridge.dispose()
    const second = child.send('call')
    await Promise.all([first, disposed, second])
    assert.equal(mock.refreshes(), 1)
    assert.equal(JSON.parse(await readFile(file, 'utf8')).tokens.refresh_token, 'rotated-refresh-1')
  } finally {
    if (child) { await child.send('dispose').catch(() => {}); await child.kill() }
    await bridge.dispose()
    await mock.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('a lost refresh response is not retried with a possibly rotated token', async () => {
  const mock = await startMockMcp({ oauth: true, rotateRefresh: true, dropRefreshResponse: true })
  const root = await mkdtemp(join(tmpdir(), 'atlassian-process-lost-refresh-'))
  const file = join(root, 'session.json')
  const bridge = new AtlassianBridge({ logger, register() { return () => {} } }, {
    serverName: 'atlassian', url: mock.url, redirectPort: 0, toolCallTimeoutMs: 5000,
    expectedSite: '', authorizationTimeoutMs: 5000, autoOpenBrowser: false, store: new SessionStore(file),
  })
  let child
  try {
    await bridge.start()
    await waitFor(() => bridge.snapshot().status === 'authorizing')
    await fetch(bridge.snapshot().authorizationUrl)
    await waitFor(() => bridge.snapshot().status === 'ready')
    const saved = JSON.parse(await readFile(file, 'utf8'))
    child = childBridge(mock.url, file, Number(new URL(saved.redirectUri).port))
    assert.equal((await child.send('start')).status, 'ready')
    mock.expire()
    await assert.rejects(bridge.callTool('getJiraIssue', { issueIdOrKey: 'DEMO-1' }))
    await assert.rejects(child.send('call'))
    assert.equal(mock.refreshes(), 1)
    assert.equal(JSON.parse(await readFile(file, 'utf8')).tokens, undefined)
    assert.equal(bridge.snapshot().status, 'error')
    await bridge.authorize()
    await waitFor(() => bridge.snapshot().status === 'authorizing')
    assert.equal((await fetch(bridge.snapshot().authorizationUrl)).status, 200)
    await waitFor(() => bridge.snapshot().status === 'ready')
    await bridge.callTool('getJiraIssue', { issueIdOrKey: 'DEMO-1' })
  } finally {
    if (child) { await child.send('dispose').catch(() => {}); await child.kill() }
    await bridge.dispose()
    await mock.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('a fallback callback port re-registers before interactive reauthorization', async () => {
  const mock = await startMockMcp({ oauth: true, strictRedirect: true })
  const root = await mkdtemp(join(tmpdir(), 'atlassian-process-redirect-'))
  const file = join(root, 'session.json')
  const bridge = new AtlassianBridge({ logger, register() { return () => {} } }, {
    serverName: 'atlassian', url: mock.url, redirectPort: 0, toolCallTimeoutMs: 5000,
    expectedSite: '', authorizationTimeoutMs: 5000, autoOpenBrowser: false, store: new SessionStore(file),
  })
  let child
  try {
    await bridge.start()
    await waitFor(() => bridge.snapshot().status === 'authorizing')
    assert.equal((await fetch(bridge.snapshot().authorizationUrl)).status, 200)
    await waitFor(() => bridge.snapshot().status === 'ready')
    const saved = JSON.parse(await readFile(file, 'utf8'))
    child = childBridge(mock.url, file, Number(new URL(saved.redirectUri).port))
    assert.equal((await child.send('start')).status, 'ready')
    mock.expire()
    mock.revokeRefresh()
    await assert.rejects(child.send('call'))
    const state = await child.send('authorize')
    assert.equal(state.status, 'authorizing')
    assert.notEqual(new URL(state.authorizationUrl).searchParams.get('redirect_uri'), saved.redirectUri)
    assert.equal((await fetch(state.authorizationUrl)).status, 200)
    for (let i = 0; i < 100; i++) {
      if ((await child.send('snapshot')).status === 'ready') break
      await delay(25)
    }
    assert.equal((await child.send('snapshot')).status, 'ready')
    await child.send('call')
  } finally {
    if (child) { await child.send('dispose').catch(() => {}); await child.kill() }
    await bridge.dispose()
    await mock.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('session writes merge across processes and a crashed lock holder is released', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlassian-process-store-'))
  const file = join(root, 'session.json')
  const store = new SessionStore(file)
  const child = childBridge('http://127.0.0.1:1/mcp', file, 0)
  try {
    await store.load()
    await Promise.all([store.patch({ site: 'example.test' }), child.send('patch')])
    const saved = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(saved.site, 'example.test')
    assert.equal(saved.codeVerifier, 'child-verifier')
    await child.send('hold')
    const controller = new AbortController()
    const cancelled = store.patch({ site: 'cancelled.test' }, () => true, undefined, undefined, controller.signal)
    controller.abort()
    await assert.rejects(cancelled, /cancelled/)
    const waiting = store.patch({ site: 'after-crash.test' })
    await delay(50)
    await child.kill()
    await waiting
    assert.equal(JSON.parse(await readFile(file, 'utf8')).site, 'after-crash.test')
  } finally { await child.kill(); await rm(root, { recursive: true, force: true }) }
})

test('a second store in the same process cannot release another store’s cross-process lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlassian-process-lock-'))
  const file = join(root, 'session.json')
  const first = new SessionStore(file)
  const second = new SessionStore(file)
  const child = childBridge('http://127.0.0.1:1/mcp', file, 0)
  const abort = new AbortController()
  let lease
  try {
    lease = await first.acquire()
    const waiting = second.acquire(abort.signal).then(() => undefined, (error) => error)
    await delay(75)
    let childAcquired = false
    let childError
    const childWaiting = child.send('hold').then(() => { childAcquired = true }, (error) => { childError = error })
    await delay(150)
    assert.equal(childAcquired, false)
    abort.abort()
    assert.match(String(await waiting), /cancelled/)
    lease.release()
    lease = undefined
    await childWaiting
    if (childError) throw childError
    assert.equal(childAcquired, true)
  } finally { abort.abort(); lease?.release(); await child.kill(); await rm(root, { recursive: true, force: true }) }
})

test('an authorization started without tokens cannot replace a newer session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlassian-stale-authorization-'))
  const file = join(root, 'session.json')
  const stale = new SessionStore(file)
  const winner = new SessionStore(file)
  const tokens = { access_token: 'new-access', refresh_token: 'new-refresh', token_type: 'Bearer' }
  try {
    await stale.load()
    await winner.patch({ tokens, clientInformation: { client_id: 'new-client' }, redirectUri: 'http://127.0.0.1:3334/callback' })
    await assert.rejects(stale.patch({ clientInformation: { client_id: 'old-client' } }, () => true, undefined, undefined, undefined, true), /credentials changed/)
    await stale.saveTokens({ access_token: 'old-access', token_type: 'Bearer' }, () => true, undefined, undefined, undefined, true)
    await stale.rebindRedirect('http://127.0.0.1:4444/callback', undefined, () => true)
    await stale.clearCredentialsIf(() => true, undefined, undefined, undefined, true, 'tokens', 'clientInformation')
    const saved = JSON.parse(await readFile(file, 'utf8'))
    assert.deepEqual(saved.tokens, tokens)
    assert.equal(saved.clientInformation.client_id, 'new-client')
    assert.equal(saved.redirectUri, 'http://127.0.0.1:3334/callback')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('disposal interrupts a site update waiting for another process', async () => {
  const mock = await startMockMcp({ resourceDelay: 400 })
  const root = await mkdtemp(join(tmpdir(), 'atlassian-process-site-'))
  const file = join(root, 'session.json')
  const bridge = new AtlassianBridge({ logger, register() { return () => {} } }, {
    serverName: 'atlassian', url: mock.url, redirectPort: 0, toolCallTimeoutMs: 5000,
    expectedSite: '', authorizationTimeoutMs: 5000, autoOpenBrowser: false, store: new SessionStore(file),
  })
  const child = childBridge(mock.url, file, 0)
  let boot
  try {
    boot = bridge.start()
    await waitFor(() => mock.calls.some((call) => call.method === 'tools/call' && call.params.name === 'getAccessibleAtlassianResources'))
    await child.send('hold')
    await delay(450)
    await Promise.race([bridge.dispose(), delay(500).then(() => { throw new Error('disposal waited for another process') })])
    await boot
  } finally { await child.kill(); await bridge.dispose(); await mock.close(); await rm(root, { recursive: true, force: true }) }
})

test('connects to MCP, registers usable tools and loads a Jira board', async () => {
  const mock = await startMockMcp()
  const root = await mkdtemp(join(tmpdir(), 'atlassian-bridge-'))
  const file = join(root, 'session.json')
  const tools = new Map()
  const bridge = new AtlassianBridge({ logger, register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } }, {
    serverName: 'atlassian', url: mock.url, redirectPort: 0, toolCallTimeoutMs: 5000, expectedSite: 'ample.atlassian.net', authorizationTimeoutMs: 5000, autoOpenBrowser: false, store: new SessionStore(file),
  })
  try {
    await bridge.start()
    await waitFor(() => bridge.snapshot().status === 'ready')
    assert.equal(bridge.snapshot().site, 'example.atlassian.net')
    assert.equal(bridge.snapshot().siteMismatch, true)
    assert.equal(tools.size, 3)
    const result = await tools.get('mcp__atlassian__getJiraIssue').execute({ issueIdOrKey: 'DEMO-1' }, {})
    assert.match(result.content[0].text, /Mock issue/)
    const board = await new JiraBoard(bridge).load({ jql: 'project = DEMO', limit: 10, timeoutMs: 5000 })
    assert.equal(board.issues[0].key, 'DEMO-1')
    assert.ok(mock.calls.some((call) => call.method === 'tools/call' && call.params.arguments.cloudId === 'mock-cloud-id'))
    await bridge.disconnect()
    assert.equal(tools.size, 0)
    assert.equal(bridge.snapshot().status, 'idle')
    await assert.rejects(stat(file), { code: 'ENOENT' })
  } finally { await bridge.dispose(); await mock.close(); await rm(root, { recursive: true, force: true }) }
})

test('OAuth code with PKCE is exchanged and a saved session can refresh', async () => {
  const mock = await startMockMcp({ oauth: true })
  const root = await mkdtemp(join(tmpdir(), 'atlassian-oauth-'))
  const file = join(root, 'session.json')
  const tools = new Map()
  const host = { logger, register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } }
  const options = { serverName: 'atlassian', url: mock.url, redirectPort: 0, toolCallTimeoutMs: 5000, expectedSite: '', authorizationTimeoutMs: 5000, autoOpenBrowser: false }
  let bridge = new AtlassianBridge(host, { ...options, store: new SessionStore(file) })
  try {
    await bridge.start()
    await waitFor(() => bridge.snapshot().status === 'authorizing')
    const url = new URL(bridge.snapshot().authorizationUrl)
    assert.ok(url.searchParams.get('state'))
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
    assert.ok(url.searchParams.get('code_challenge'))
    await delay(20)
    assert.equal((await fetch(url)).status, 200)
    await waitFor(() => bridge.snapshot().status === 'ready')
    assert.equal(tools.size, 3)
    const saved = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(saved.tokens.access_token, 'first-access-token')
    assert.equal(saved.codeVerifier, undefined)
    const port = Number(new URL(saved.redirectUri).port)
    await bridge.dispose()
    mock.expire()
    bridge = new AtlassianBridge(host, { ...options, redirectPort: port, store: new SessionStore(file) })
    await bridge.start()
    await waitFor(() => bridge.snapshot().status === 'ready')
    assert.equal(mock.refreshes(), 1)
    assert.equal(JSON.parse(await readFile(file, 'utf8')).tokens.access_token, 'refreshed-access-token')
    assert.equal(tools.size, 3)
  } finally { await bridge.dispose(); await mock.close(); await rm(root, { recursive: true, force: true }) }
})

for (const { staleUnauthorizedDelay, clientSecretBasic } of [{ staleUnauthorizedDelay: 0, clientSecretBasic: false }, { staleUnauthorizedDelay: 300, clientSecretBasic: false }, { staleUnauthorizedDelay: 0, clientSecretBasic: true }]) {
  test(`concurrent rotating refreshes keep credentials with delayed 401=${staleUnauthorizedDelay}, basic=${clientSecretBasic}`, async () => {
    const mock = await startMockMcp({ oauth: true, rotateRefresh: true, refreshDelay: 100, staleUnauthorizedDelay, clientSecretBasic })
    const root = await mkdtemp(join(tmpdir(), 'atlassian-rotating-refresh-'))
    const file = join(root, 'session.json')
    const tools = new Map()
    const host = { logger, register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } }
    const bridge = new AtlassianBridge(host, { serverName: 'atlassian', url: mock.url, redirectPort: 0, toolCallTimeoutMs: 5000, expectedSite: '', authorizationTimeoutMs: 5000, autoOpenBrowser: false, store: new SessionStore(file) })
    try {
      await bridge.start()
      await waitFor(() => bridge.snapshot().status === 'authorizing')
      assert.equal((await fetch(bridge.snapshot().authorizationUrl)).status, 200)
      await waitFor(() => bridge.snapshot().status === 'ready')
      mock.expire()
      const definition = tools.get('mcp__atlassian__getJiraIssue')
      const results = await Promise.all([
        definition.execute({ issueIdOrKey: 'DEMO-1' }, {}),
        definition.execute({ issueIdOrKey: 'DEMO-1' }, {}),
        bridge.callTool('getJiraIssue', { issueIdOrKey: 'DEMO-1' }),
      ])
      assert.equal(results.length, 3)
      assert.equal(mock.refreshes(), 1)
      const saved = JSON.parse(await readFile(file, 'utf8')).tokens
      assert.equal(saved.access_token, 'refreshed-access-token')
      assert.equal(saved.refresh_token, 'rotated-refresh-1')
      assert.ok((await definition.execute({ issueIdOrKey: 'DEMO-1' }, {})).content.length)
    } finally { await bridge.dispose(); await mock.close(); await rm(root, { recursive: true, force: true }) }
  })
}

test('disconnect cancels an in-flight refresh without recreating credentials', async () => {
  const mock = await startMockMcp({ oauth: true, rotateRefresh: true, refreshDelay: 500 })
  const root = await mkdtemp(join(tmpdir(), 'atlassian-refresh-disconnect-'))
  const file = join(root, 'session.json')
  const tools = new Map()
  const host = { logger, register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } }
  const bridge = new AtlassianBridge(host, { serverName: 'atlassian', url: mock.url, redirectPort: 0, toolCallTimeoutMs: 5000, expectedSite: '', authorizationTimeoutMs: 5000, autoOpenBrowser: false, store: new SessionStore(file) })
  try {
    await bridge.start()
    await waitFor(() => bridge.snapshot().status === 'authorizing')
    await fetch(bridge.snapshot().authorizationUrl)
    await waitFor(() => bridge.snapshot().status === 'ready')
    mock.expire()
    const request = tools.get('mcp__atlassian__getJiraIssue').execute({ issueIdOrKey: 'DEMO-1' }, {}).catch((error) => error)
    await waitFor(() => mock.refreshes() === 1)
    await bridge.disconnect()
    await request
    await delay(600)
    await assert.rejects(stat(file), { code: 'ENOENT' })
    assert.equal(bridge.snapshot().status, 'idle')
  } finally { await bridge.dispose(); await mock.close(); await rm(root, { recursive: true, force: true }) }
})

for (const clientSecretBasic of [false, true]) test(`event-stream and tool requests share one rotating refresh with basic=${clientSecretBasic}`, async () => {
  const mock = await startMockMcp({ oauth: true, rotateRefresh: true, refreshDelay: 300, serverEvents: true, clientSecretBasic })
  const root = await mkdtemp(join(tmpdir(), 'atlassian-sse-refresh-'))
  const file = join(root, 'session.json')
  const tools = new Map()
  const host = { logger, register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } }
  const bridge = new AtlassianBridge(host, { serverName: 'atlassian', url: mock.url, redirectPort: 0, toolCallTimeoutMs: 5000, expectedSite: '', authorizationTimeoutMs: 5000, autoOpenBrowser: false, store: new SessionStore(file) })
  try {
    await bridge.start()
    await waitFor(() => bridge.snapshot().status === 'authorizing')
    await fetch(bridge.snapshot().authorizationUrl)
    await waitFor(() => bridge.snapshot().status === 'ready' && mock.streams() === 1)
    mock.expire()
    await waitFor(() => mock.refreshes() === 1)
    const tool = tools.get('mcp__atlassian__getJiraIssue')
    await Promise.all([tool.execute({ issueIdOrKey: 'DEMO-1' }, {}), bridge.callTool('getJiraIssue', { issueIdOrKey: 'DEMO-1' })])
    assert.equal(mock.refreshes(), 1)
    assert.equal(JSON.parse(await readFile(file, 'utf8')).tokens.refresh_token, 'rotated-refresh-1')
    await waitFor(() => mock.streams() === 1)
  } finally { await bridge.dispose(); await mock.close(); await rm(root, { recursive: true, force: true }) }
})

test('a terminal refresh error releases the refresh lock for a later retry', async () => {
  const mock = await startMockMcp({ oauth: true, rotateRefresh: true, refreshErrorOnce: true })
  const root = await mkdtemp(join(tmpdir(), 'atlassian-refresh-error-'))
  const file = join(root, 'session.json')
  const tools = new Map()
  const host = { logger, register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } }
  const bridge = new AtlassianBridge(host, { serverName: 'atlassian', url: mock.url, redirectPort: 0, toolCallTimeoutMs: 3000, expectedSite: '', authorizationTimeoutMs: 5000, autoOpenBrowser: false, store: new SessionStore(file) })
  try {
    await bridge.start()
    await waitFor(() => bridge.snapshot().status === 'authorizing')
    await fetch(bridge.snapshot().authorizationUrl)
    await waitFor(() => bridge.snapshot().status === 'ready')
    mock.expire()
    const tool = tools.get('mcp__atlassian__getJiraIssue')
    await assert.rejects(tool.execute({ issueIdOrKey: 'DEMO-1' }, {}))
    const retried = await Promise.race([
      tool.execute({ issueIdOrKey: 'DEMO-1' }, {}),
      delay(1500).then(() => { throw new Error('refresh retry remained blocked') }),
    ])
    assert.ok(retried.content.length)
    assert.equal(mock.refreshes(), 2)
  } finally { await bridge.dispose(); await mock.close(); await rm(root, { recursive: true, force: true }) }
})

test('disconnect during startup cannot restore credentials or tools afterwards', async () => {
  const mock = await startMockMcp({ initializeDelay: 350 })
  const root = await mkdtemp(join(tmpdir(), 'atlassian-cancel-'))
  const file = join(root, 'session.json')
  const tools = new Map()
  const bridge = new AtlassianBridge({ logger, register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } }, {
    serverName: 'atlassian', url: mock.url, redirectPort: 0, toolCallTimeoutMs: 5000, expectedSite: '', authorizationTimeoutMs: 5000, autoOpenBrowser: false, store: new SessionStore(file),
  })
  try {
    const start = bridge.start()
    await waitFor(() => mock.calls.some((call) => call.method === 'initialize'))
    await bridge.disconnect()
    await start
    await delay(50)
    assert.equal(bridge.snapshot().status, 'idle')
    assert.equal(tools.size, 0)
    await assert.rejects(stat(file), { code: 'ENOENT' })
  } finally { await bridge.dispose(); await mock.close(); await rm(root, { recursive: true, force: true }) }
})

test('OAuth rejects an insecure discovered token endpoint before sending the code', async () => {
  const mock = await startMockMcp({ oauth: true, tokenEndpoint: 'http://example.invalid/token' })
  const root = await mkdtemp(join(tmpdir(), 'atlassian-insecure-oauth-'))
  const file = join(root, 'session.json')
  const bridge = new AtlassianBridge({ logger, register: () => () => {} }, {
    serverName: 'atlassian', url: mock.url, redirectPort: 0, toolCallTimeoutMs: 5000,
    expectedSite: '', authorizationTimeoutMs: 5000, autoOpenBrowser: false, store: new SessionStore(file),
  })
  try {
    await bridge.start()
    await waitFor(() => bridge.snapshot().status === 'authorizing')
    assert.equal((await fetch(bridge.snapshot().authorizationUrl)).status, 200)
    await waitFor(() => bridge.snapshot().status === 'error')
    assert.match(bridge.snapshot().error, /must use HTTPS/)
    const saved = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(saved.tokens, undefined)
  } finally { await bridge.dispose(); await mock.close(); await rm(root, { recursive: true, force: true }) }
})

test('a reconnect invalidates the cached board site and resolves it again', async () => {
  const mock = await startMockMcp()
  const root = await mkdtemp(join(tmpdir(), 'atlassian-epoch-'))
  const file = join(root, 'session.json')
  const bridge = new AtlassianBridge({ logger, register() { return () => {} } }, {
    serverName: 'atlassian', url: mock.url, redirectPort: 0, toolCallTimeoutMs: 5000,
    expectedSite: '', authorizationTimeoutMs: 5000, autoOpenBrowser: false, store: new SessionStore(file),
  })
  const resourceCalls = () => mock.calls.filter((call) => call.method === 'tools/call' && call.params.name === 'getAccessibleAtlassianResources').length
  try {
    await bridge.start()
    await waitFor(() => bridge.snapshot().status === 'ready')
    const board = new JiraBoard(bridge)
    assert.equal(await board.cloudId(), 'mock-cloud-id')
    assert.equal(board.site, 'example.atlassian.net')
    const before = resourceCalls()
    assert.equal(await board.cloudId(), 'mock-cloud-id')
    assert.equal(resourceCalls(), before, 'a live connection keeps its cached site')
    const epoch = bridge.epoch()
    await bridge.disconnect()
    assert.ok(bridge.epoch() > epoch)
    assert.equal(board.site, undefined, 'the cached site must not survive a disconnect')
    await bridge.start()
    await waitFor(() => bridge.snapshot().status === 'ready')
    assert.equal(await board.cloudId(), 'mock-cloud-id')
    // The connect-time resolution is shared with the board: no second MCP call.
    assert.equal(resourceCalls(), before + 1, 'the board reuses the site resolved while reconnecting')
    assert.equal(board.site, 'example.atlassian.net')
  } finally { await bridge.dispose(); await mock.close(); await rm(root, { recursive: true, force: true }) }
})
