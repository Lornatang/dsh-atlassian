import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
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
