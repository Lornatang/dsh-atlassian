import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { AtlassianOAuthProvider, CallbackServer, createCloudFetch } from '../lib/oauth.js'
import { JiraBoard } from '../lib/board.js'
import { registerRoutes } from '../lib/routes.js'
import { SessionStore, sessionFileFor } from '../lib/store.js'

test('Cloud OAuth never sends credentials to insecure discovered endpoints', async () => {
  assert.throws(() => createCloudFetch(new URL('http://example.test/mcp')), /must use HTTPS/)
  assert.throws(() => createCloudFetch(new URL('https://user:secret@example.test/mcp')), /must use HTTPS/)
  const secure = createCloudFetch(new URL('https://example.test/mcp'))
  await assert.rejects(secure.fetch('http://example.test/token', { method: 'POST', body: 'refresh_token=secret' }), /must use HTTPS/)
  await assert.rejects(secure.fetch('http://127.0.0.1/token', { method: 'POST', body: 'refresh_token=secret' }), /must use HTTPS/)
  const local = createCloudFetch(new URL('http://127.0.0.1:3000/mcp'))
  await assert.rejects(local.fetch('http://example.test/token'), /must use HTTPS/)
  const provider = new AtlassianOAuthProvider({
    store: {}, redirectUri: () => 'http://127.0.0.1:3000/callback',
    onAuthorizationUrl() {}, allowLoopbackHttp: false, logger: { info() {}, warn() {}, error() {} },
  })
  assert.throws(() => provider.redirectToAuthorization(new URL('http://127.0.0.1/authorize')), /must use HTTPS/)
  assert.throws(() => provider.redirectToAuthorization(new URL('https://user:secret@example.test/authorize')), /must use HTTPS/)
})

test('Cloud fetch does not automatically follow redirects', async () => {
  let calls = 0
  const server = createServer((req, res) => {
    calls++
    res.writeHead(307, { location: '/redirect-target' }).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${server.address().port}/token`
    const network = createCloudFetch(new URL(url))
    const response = await network.fetch(url, { method: 'POST', body: 'refresh_token=secret', redirect: 'follow' })
    assert.equal(response.status, 307)
    assert.equal(calls, 1)
    await response.body?.cancel()
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) }
})

test('Cloud fetch bounds decoded responses and individual SSE events', async () => {
  const limit = 10 * 1024 * 1024
  const large = 'x'.repeat(limit + 1)
  const event = `data: ${'x'.repeat(6 * 1024 * 1024)}\r\n\r\n`
  const manyEvents = `data: ${'x'.repeat(1024)}\n\n`.repeat(11000)
  const server = createServer((req, res) => {
    if (req.url === '/compressed') {
      res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'application/json' }).end(gzipSync(large))
    } else if (req.url === '/error') {
      res.writeHead(500, { 'content-type': 'text/event-stream' }).end(manyEvents)
    } else if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' }).end(event + event)
    } else if (req.url === '/large-event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`data: ${large}\n\n`)
    } else {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const network = createCloudFetch(new URL(`${base}/mcp`))
    const normal = await network.fetch(`${base}/ok`)
    assert.equal(normal.url, `${base}/ok`)
    assert.deepEqual(await normal.json(), { ok: true })
    const compressed = await network.fetch(`${base}/compressed`)
    await assert.rejects(compressed.text(), /response exceeded the size limit/)
    const error = await network.fetch(`${base}/error`, { headers: { accept: 'text/event-stream' } })
    await assert.rejects(error.text(), /response exceeded the size limit/)
    const events = await network.fetch(`${base}/events`, { headers: { accept: 'application/json, text/event-stream' } })
    assert.equal((await events.text()).length, event.length * 2)
    const oversizedEvent = await network.fetch(`${base}/large-event`, { headers: { accept: 'text/event-stream' } })
    await assert.rejects(oversizedEvent.text(), /event exceeded the size limit/)
    // An OAuth-style request must use the whole-response limit, even if a
    // server incorrectly labels its body as an event stream.
    const mislabeled = await network.fetch(`${base}/events`)
    await assert.rejects(mislabeled.text(), /response exceeded the size limit/)
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) }
})

test('Jira board ignores unsafe resource URLs from the remote service', async () => {
  const bridge = {
    rawNameMatching: () => 'getAccessibleAtlassianResources',
    callTool: async () => [{ type: 'text', text: JSON.stringify([
      { id: 'bad', url: 'javascript:alert(1)' },
      { id: 'bad-credentials', url: 'https://user:pass@example.test' },
      { id: 'good', url: 'https://example.test' },
    ]) }],
  }
  const board = new JiraBoard(bridge)
  assert.equal(await board.cloudId(), 'good')
  assert.equal(board.site, 'example.test')
})

test('OAuth callback requires state, rejects stray requests and escapes error text', async () => {
  const server = new CallbackServer()
  await server.listen(0)
  try {
    await assert.rejects(server.waitForCode(1000, undefined), /state/)
    const waiting = server.waitForCode(3000, 'correct')
    const wrong = await fetch(`${server.redirectUri}?error=access_denied&state=wrong`)
    assert.equal(wrong.status, 400)
    const valid = await fetch(`${server.redirectUri}?code=abc&state=correct`)
    assert.equal(valid.status, 200)
    assert.deepEqual(await waiting, { code: 'abc', state: 'correct' })
    const errorWait = server.waitForCode(3000, 'next')
    const rejected = assert.rejects(errorWait, /authorization failed/)
    const response = await fetch(`${server.redirectUri}?state=next&error=invalid&error_description=%3Cscript%3Ealert(1)%3C%2Fscript%3E`)
    const body = await response.text()
    assert.equal(response.status, 400)
    assert.ok(body.includes('&lt;script&gt;'))
    assert.ok(!body.includes('<script>'))
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'/)
    await rejected
    assert.equal((await fetch(`${server.redirectUri}?code=abc&state=next`)).status, 400)
  } finally { await server.close() }
})

test('credentials are profile-isolated, owner-only, atomic and not silently replaced', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlassian-store-'))
  try {
    const file = sessionFileFor('atlassian', 'https://example.test/mcp', join(root, 'profiles', 'one', 'cordis.patch.yml'))
    const other = sessionFileFor('atlassian', 'https://example.test/mcp', join(root, 'profiles', 'two', 'cordis.patch.yml'))
    assert.notEqual(file, other)
    assert.throws(() => sessionFileFor('../bad', 'https://example.test'), /serverName/)
    const store = new SessionStore(file)
    await store.load()
    await Promise.all([store.patch({ site: 'example.test' }), store.patch({ codeVerifier: 'secret' })])
    assert.equal((await new SessionStore(file).load()).site, 'example.test')
    assert.equal((await new SessionStore(file).load()).codeVerifier, 'secret')
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o077, 0)
    await store.clear('codeVerifier')
    assert.equal((await new SessionStore(file).load()).codeVerifier, undefined)
    await writeFile(file, 'not-json')
    await assert.rejects(new SessionStore(file).load(), /invalid credential file/)
    assert.equal(await readFile(file, 'utf8'), 'not-json')
    await rm(file)
    await mkdir(join(root, 'elsewhere'), { recursive: true })
    const target = join(root, 'elsewhere', 'target')
    await writeFile(target, 'do not modify')
    await symlink(target, file)
    await assert.rejects(new SessionStore(file).load(), /regular file/)
    assert.equal(await readFile(target, 'utf8'), 'do not modify')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('HTTP routes fail closed until the DSH connection fence is available', async () => {
  let handler
  let updates = 0
  const web = { register(route) { handler = route.handler; return () => {} } }
  const bridge = { snapshot: () => ({ status: 'idle', siteMismatch: false, toolCount: 0 }) }
  const options = { jql: '', limit: 50, timeoutMs: 1000, promptTemplate: '' }
  const connection = { snapshot: () => ({}), update: async () => { updates++ } }
  const server = createServer((req, res) => void handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/plugins/atlassian/status`
  try {
    registerRoutes(web, bridge, {}, options, undefined)
    assert.equal((await fetch(url)).status, 503)
    registerRoutes(web, bridge, {}, options, { requestRejection: () => 401 }, connection)
    assert.equal((await fetch(url)).status, 401)
    assert.equal((await fetch(url.replace('/status', '/configure'), { method: 'POST', body: '{}' })).status, 401)
    assert.equal(updates, 0)
    registerRoutes(web, bridge, {}, options, { requestRejection: () => undefined }, connection)
    assert.equal((await fetch(url)).status, 200)
    assert.equal((await fetch(url.replace('/status', '/configure'), { method: 'POST', body: '{}' })).status, 200)
    assert.equal(updates, 1)
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) }
})
