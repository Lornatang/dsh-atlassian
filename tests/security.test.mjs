import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { connect } from 'node:net'
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
    onAuthorizationUrl() {}, allowLoopbackHttp: false,
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
  const server = createServer(async (req, res) => {
    res.on('error', () => {})
    if (req.url === '/split-events') {
      req.socket.setNoDelay(true)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const part of ['data: one\r', '\n\r', '\ndata: two\r', '\r\n', 'data: three\n', '\n']) {
        res.write(part)
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      res.end()
    } else if (req.url === '/cr-events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: cr\r\rdata: next\r\r')
    } else if (req.url === '/split-large') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: ')
      const block = 'x'.repeat(1024 * 1024)
      for (let i = 0; i < 11 && !res.destroyed; i++) {
        res.write(block)
        await new Promise((resolve) => setTimeout(resolve, 2))
      }
      if (!res.destroyed) res.end('\n\n')
    } else if (req.url === '/compressed') {
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
    // CR/LF/CRLF separators split across network chunks must keep their meaning.
    const split = await network.fetch(`${base}/split-events`, { headers: { accept: 'text/event-stream' } })
    assert.equal(await split.text(), 'data: one\r\n\r\ndata: two\r\r\ndata: three\n\n')
    const crOnly = await network.fetch(`${base}/cr-events`, { headers: { accept: 'text/event-stream' } })
    assert.equal(await crOnly.text(), 'data: cr\r\rdata: next\r\r')
    const splitLarge = await network.fetch(`${base}/split-large`, { headers: { accept: 'text/event-stream' } })
    await assert.rejects(splitLarge.text(), /event exceeded the size limit/)
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

test('Jira board refreshes its cached site when the bridge reconnects', async () => {
  let epoch = 0
  let lookups = 0
  const bridge = {
    epoch: () => epoch,
    rawNameMatching: () => 'getAccessibleAtlassianResources',
    callTool: async () => {
      lookups++
      return [{ type: 'text', text: JSON.stringify([
        epoch === 0
          ? { id: 'first', url: 'https://one.example.test' }
          : { id: 'second', url: 'https://two.example.test' },
      ]) }]
    },
  }
  const board = new JiraBoard(bridge)
  assert.equal(await board.cloudId(), 'first')
  assert.equal(board.site, 'one.example.test')
  assert.equal(await board.cloudId(), 'first')
  assert.equal(lookups, 1)
  epoch = 1
  assert.equal(await board.cloudId(), 'second')
  assert.equal(board.site, 'two.example.test')
  assert.equal(lookups, 2)
})

test('Jira board reuses the site resolved by the bridge while connecting', async () => {
  let lookups = 0
  let sharedEpoch = 3
  const bridge = {
    epoch: () => 3,
    resource: () => sharedEpoch === 3
      ? { epoch: 3, id: 'shared', base: 'https://shared.example.test', site: 'shared.example.test' }
      : undefined,
    rawNameMatching: () => 'getAccessibleAtlassianResources',
    callTool: async () => {
      lookups++
      return [{ type: 'text', text: JSON.stringify([{ id: 'lookup', url: 'https://lookup.example.test' }]) }]
    },
  }
  const board = new JiraBoard(bridge)
  assert.equal(await board.cloudId(), 'shared')
  assert.equal(board.site, 'shared.example.test')
  assert.equal(await board.cloudId(), 'shared')
  assert.equal(lookups, 0, 'the connect-time resolution needs no extra MCP call')
  // A connect-time result from another generation must not be trusted.
  sharedEpoch = 2
  const stale = new JiraBoard(bridge)
  assert.equal(await stale.cloudId(), 'lookup')
  assert.equal(lookups, 1)
})

test('a successful token invalidation resets the stale observation so reauthorization can proceed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlassian-reset-'))
  try {
    const file = sessionFileFor('atlassian', 'https://example.test/mcp', join(root, 'profiles', 'one', 'cordis.patch.yml'))
    const store = new SessionStore(file)
    await store.load()
    await store.patch({ redirectUri: 'http://127.0.0.1:3000/callback', site: 'example.test' })
    await store.saveTokens({ access_token: 'stale-access', refresh_token: 'stale-refresh', token_type: 'Bearer' }, () => true, undefined, undefined, undefined, true)
    let observed = store.current.tokens
    let resets = 0
    const provider = new AtlassianOAuthProvider({
      store,
      redirectUri: () => store.current.redirectUri,
      onAuthorizationUrl() {},
      allowLoopbackHttp: false,
      active: () => true,
      observedTokens: () => observed,
      refreshExpected: () => undefined,
      resetObservation: () => { resets++; observed = undefined },
    })
    await provider.invalidateCredentials('tokens')
    assert.equal(store.current.tokens, undefined)
    assert.equal(observed, undefined)
    assert.equal(resets, 1)
    // The follow-up authorization-code exchange must be able to write again;
    // before the fix the stale observation made every guarded patch reject.
    await provider.saveCodeVerifier('fresh-verifier')
    assert.equal(store.current.codeVerifier, 'fresh-verifier')
  } finally { await rm(root, { recursive: true, force: true }) }
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
    const raw = await new Promise((resolve) => {
      const socket = connect(server.address().port, '127.0.0.1', () => {
        socket.write('GET http://[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')
      })
      let data = ''
      socket.on('data', (chunk) => { data += chunk })
      socket.on('end', () => resolve(data))
      socket.on('error', () => resolve(data))
    })
    assert.match(raw, /^HTTP\/1\.1 400/)
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) }
})

test('a board re-resolves its site after the bridge epoch changes and dedups concurrent lookups', async () => {
  let epoch = 1
  let lookups = 0
  const bridge = {
    epoch: () => epoch,
    rawNameMatching: () => 'getAccessibleAtlassianResources',
    callTool: async () => {
      lookups++
      await new Promise((resolve) => setTimeout(resolve, 20))
      return [{ type: 'text', text: JSON.stringify([{ id: `cloud-${epoch}`, url: `https://site-${epoch}.atlassian.net` }]) }]
    },
  }
  const board = new JiraBoard(bridge)
  assert.equal(await board.cloudId(), 'cloud-1')
  assert.equal(board.site, 'site-1.atlassian.net')
  epoch = 2
  assert.equal(board.site, undefined, 'a stale epoch must not expose the old site')
  const [first, second] = await Promise.all([board.cloudId(), board.cloudId()])
  assert.equal(first, 'cloud-2')
  assert.equal(second, 'cloud-2')
  assert.equal(lookups, 2, 'concurrent lookups share one resolution')
})

test('HTTP routes reject malformed encodings instead of failing with a server error', async () => {
  let handler
  let boardCalls = 0
  const web = { register(route) { handler = route.handler; return () => {} } }
  const bridge = { snapshot: () => ({ status: 'ready', siteMismatch: false, toolCount: 1 }) }
  const board = {
    detail: async () => { boardCalls++; return { issue: {}, description: '' } },
    transitions: async () => { boardCalls++; return [] },
  }
  const options = { jql: '', limit: 50, timeoutMs: 1000, promptTemplate: '' }
  const server = createServer((req, res) => void handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    registerRoutes(web, bridge, board, options, { requestRejection: () => undefined })
    const badKey = await fetch(`${base}/plugins/atlassian/issue/%E0%A4%A`)
    assert.equal(badKey.status, 400)
    assert.equal((await badKey.json()).code, 'bad-request')
    const res = { status: 0, body: '', writeHead(status) { this.status = status; return this }, end(body) { this.body = body ?? '' } }
    await handler({ url: 'http://[', method: 'GET' }, res)
    assert.equal(res.status, 400)
    assert.match(res.body, /Invalid request URL/)
    assert.equal(boardCalls, 0, 'malformed requests must not reach the board')
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) }
})

test('an in-flight board response keeps its original site and issue links after reconnect', async () => {
  let epoch = 1
  const { promise: searchStarted, resolve: startSearch } = Promise.withResolvers()
  const { promise: searchFinished, resolve: finishSearch } = Promise.withResolvers()
  const bridge = {
    epoch: () => epoch,
    rawNameMatching: (pattern) => ['getAccessibleAtlassianResources', 'searchJiraIssuesUsingJql'].find((name) => pattern.test(name)),
    callTool: async (name, args) => {
      if (name === 'getAccessibleAtlassianResources') {
        return [{ type: 'text', text: epoch === 1 ? '{"id":"first","url":"https://first.example.test/jira"}' : '{"id":"second","url":"https://second.example.test"}' }]
      }
      assert.equal(args.cloudId, 'first')
      startSearch()
      await searchFinished
      return [{ type: 'text', text: '{"issues":[{"key":"DEMO-1","fields":{"summary":"Old issue"}}]}' }]
    },
  }
  const board = new JiraBoard(bridge)
  const pending = board.load({ limit: 10, timeoutMs: 1000 })
  await searchStarted
  epoch = 2
  assert.equal(await board.cloudId(), 'second')
  finishSearch()
  const loaded = await pending
  assert.equal(loaded.cloudId, 'first')
  assert.equal(loaded.site, 'first.example.test')
  assert.equal(loaded.issues[0].url, 'https://first.example.test/jira/browse/DEMO-1')
})

test('a board lookup started before reconnect cannot send its old ID to the new connection', async () => {
  let epoch = 1
  const { promise: lookupStarted, resolve: startLookup } = Promise.withResolvers()
  const { promise: lookupFinished, resolve: finishLookup } = Promise.withResolvers()
  const bridge = {
    epoch: () => epoch,
    rawNameMatching: (pattern) => ['getAccessibleAtlassianResources', 'getJiraIssue'].find((name) => pattern.test(name)),
    callTool: async (name, args) => {
      if (name === 'getAccessibleAtlassianResources') {
        if (epoch === 1) {
          startLookup()
          await lookupFinished
          return [{ type: 'text', text: '{"id":"first","url":"https://first.example.test"}' }]
        }
        return [{ type: 'text', text: '{"id":"second","url":"https://second.example.test"}' }]
      }
      assert.equal(args.cloudId, 'second')
      return [{ type: 'text', text: '{"key":"DEMO-1","fields":{"summary":"New issue"}}' }]
    },
  }
  const board = new JiraBoard(bridge)
  const pending = board.detail('DEMO-1', 1000)
  await lookupStarted
  epoch = 2
  finishLookup()
  await assert.rejects(pending, { code: 'not-connected' })
  assert.equal((await board.detail('DEMO-1', 1000)).issue.url, 'https://second.example.test/browse/DEMO-1')
})
