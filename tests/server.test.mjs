import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer as createHttpsServer } from 'node:https'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { JiraBoard } from '../lib/board.js'
import { ServerBridge } from '../lib/server-bridge.js'
import { ServerHttp } from '../lib/server-http.js'
import { SessionStore } from '../lib/store.js'
import { startMockServer } from './mock-server.mjs'

const logger = { info() {}, warn() {}, error() {} }

test('Server bridge authenticates both services and supports board and page operations', async () => {
  const mock = await startMockServer()
  const root = await mkdtemp(join(tmpdir(), 'atlassian-server-'))
  const file = join(root, 'session.json')
  const definitions = new Map()
  const host = { logger, register(definition) { definitions.set(definition.name, definition); return () => definitions.delete(definition.name) } }
  const config = { jiraUrl: mock.jiraUrl, confluenceUrl: mock.confluenceUrl, jiraCaFile: '', confluenceCaFile: '', allowInsecureHttp: true }
  let bridge = new ServerBridge(host, { serverName: 'atlassian', server: config, store: new SessionStore(file), timeoutMs: 5000 })
  try {
    await bridge.start()
    assert.equal(bridge.snapshot().status, 'idle')
    let result = await bridge.authorize({ jiraUsername: 'jira-user', jiraSecret: 'wrong', confluenceSecret: 'confluence-token' })
    assert.equal(result.status, 'error')
    assert.equal(definitions.size, 0)
    result = await bridge.authorize({ jiraUsername: 'jira-user', jiraSecret: 'jira-password', confluenceSecret: 'confluence-token' })
    assert.equal(result.status, 'ready')
    assert.equal(definitions.size, 14)
    assert.equal(JSON.stringify(result).includes('jira-password'), false)
    assert.equal(JSON.stringify(result).includes('confluence-token'), false)
    const board = new JiraBoard(bridge)
    const loaded = await board.load({ jql: 'project = DEMO', limit: 10, timeoutMs: 5000 })
    assert.equal(loaded.issues[0].key, 'DEMO-1')
    assert.equal(loaded.issues[0].url, mock.jiraUrl + '/browse/DEMO-1')
    assert.equal(loaded.truncated, false)
    assert.equal((await board.transitions('DEMO-1', 5000))[0].id, '11')
    await board.transition('DEMO-1', '11', 5000)
    const page = await definitions.get('mcp__atlassian__getConfluencePage').execute({ pageId: '123' }, {})
    assert.match(page.content[0].text, /Mock page/)
    await definitions.get('mcp__atlassian__updateConfluencePage').execute({ pageId: '123', title: 'Title', bodyStorage: '<p>new</p>', currentVersion: 2 }, {})
    assert.equal(mock.calls.find((call) => call.method === 'PUT').body.version.number, 3)
    assert.ok(mock.calls.some((call) => call.path.endsWith('/search') && call.body?.jql === 'project = DEMO'))
    const disk = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(disk.serverCredentials.jira.secret, 'jira-password')
    await bridge.dispose()
    bridge = new ServerBridge(host, { serverName: 'atlassian', server: config, store: new SessionStore(file), timeoutMs: 5000 })
    await bridge.start()
    assert.equal(bridge.snapshot().status, 'ready')
    assert.equal(definitions.size, 14)
    await bridge.disconnect()
    assert.equal(definitions.size, 0)
    await assert.rejects(readFile(file), { code: 'ENOENT' })
  } finally { await bridge.dispose(); await mock.close(); await rm(root, { recursive: true, force: true }) }
})

test('Server bridge can connect to either product independently', async () => {
  const mock = await startMockServer()
  const root = await mkdtemp(join(tmpdir(), 'atlassian-single-product-'))
  const cases = [
    { name: 'confluence', config: { jiraUrl: '', confluenceUrl: mock.confluenceUrl }, credentials: { confluenceSecret: 'confluence-token' }, present: 'getConfluenceSpaces', absent: 'getJiraIssue' },
    { name: 'jira', config: { jiraUrl: mock.jiraUrl, confluenceUrl: '' }, credentials: { jiraUsername: 'jira-user', jiraSecret: 'jira-password' }, present: 'getVisibleJiraProjects', absent: 'getConfluencePage' },
  ]
  try {
    for (const item of cases) {
      const tools = new Map()
      const host = { logger, register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } }
      const bridge = new ServerBridge(host, {
        serverName: 'atlassian', server: { ...item.config, jiraCaFile: '', confluenceCaFile: '', allowInsecureHttp: true },
        store: new SessionStore(join(root, `${item.name}.json`)), timeoutMs: 5000,
      })
      try {
        await bridge.start()
        assert.equal((await bridge.authorize(item.credentials)).status, 'ready')
        assert.ok(tools.has(`mcp__atlassian__${item.present}`))
        assert.ok(!tools.has(`mcp__atlassian__${item.absent}`))
        assert.ok((await tools.get(`mcp__atlassian__${item.present}`).execute({}, {})).content.length)
      } finally { await bridge.dispose() }
    }
  } finally { await mock.close(); await rm(root, { recursive: true, force: true }) }
})

test('HTTP requires an explicit opt-in and rejects unsafe base URLs', () => {
  const auth = { secret: 'token' }
  assert.throws(() => new ServerHttp('http://example.test', auth, '', false), /plaintext/)
  assert.throws(() => new ServerHttp('https://user:pass@example.test', auth, '', false), /base URL/)
  assert.throws(() => new ServerHttp('https://example.test?query=secret', auth, '', false), /base URL/)
})

test('REST requests do not follow redirects carrying credentials', async () => {
  let leaked = false
  const target = createHttpServer((req, res) => { leaked ||= !!req.headers.authorization; res.writeHead(200).end('{}') })
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve))
  const source = createHttpServer((_req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${target.address().port}/` }).end() })
  await new Promise((resolve) => source.listen(0, '127.0.0.1', resolve))
  try {
    const client = new ServerHttp(`http://127.0.0.1:${source.address().port}`, { secret: 'do-not-forward' }, '', true)
    await assert.rejects(client.request('GET', '/test'), /HTTP 302/)
    assert.equal(leaked, false)
  } finally {
    source.closeAllConnections(); target.closeAllConnections()
    await Promise.all([new Promise((resolve) => source.close(resolve)), new Promise((resolve) => target.close(resolve))])
  }
})

test('self-signed TLS requires a specifically trusted certificate', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'atlassian-ca-'))
  const cert = join(root, 'cert.pem')
  const privateKey = join(root, 'key.pem')
  const otherCert = join(root, 'other-cert.pem')
  const otherKey = join(root, 'other-key.pem')
  try {
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', privateKey, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1', '-addext', 'basicConstraints=CA:FALSE'], { stdio: 'ignore' })
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', otherKey, '-out', otherCert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-addext', 'basicConstraints=CA:FALSE'], { stdio: 'ignore' })
    } catch { t.skip('OpenSSL with -addext is required'); return }
    let requests = 0
    const server = createHttpsServer({ key: await readFile(privateKey), cert: await readFile(cert) }, (req, res) => {
      requests++
      res.writeHead(200, { 'content-type': 'application/json' }).end(req.url === '/rest/api/user/current' ? '{"username":"test-user"}' : '{"ok":true}')
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const url = `https://127.0.0.1:${server.address().port}`
      await assert.rejects(new ServerHttp(url, { secret: 'token' }, '', false).request('GET', '/test'), /self.signed|unable to (get|verify)/i)
      await assert.rejects(new ServerHttp(url, { secret: 'token' }, otherCert, false).request('GET', '/test'), /self.signed|unable to (get|verify)/i)
      assert.equal(requests, 0, 'credentials must not reach an untrusted server')
      assert.deepEqual(await new ServerHttp(url, { secret: 'token' }, cert, false).request('GET', '/test'), { ok: true })
      const tools = new Map()
      const bridge = new ServerBridge({ logger, register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } }, {
        serverName: 'atlassian', server: { jiraUrl: '', confluenceUrl: url, jiraCaFile: '', confluenceCaFile: cert, allowInsecureHttp: false },
        store: new SessionStore(join(root, 'session.json')), timeoutMs: 5000,
      })
      try {
        await bridge.start()
        assert.equal((await bridge.authorize({ confluenceSecret: 'token' })).status, 'ready')
        assert.ok(tools.has('mcp__atlassian__getConfluencePage'))
      } finally { await bridge.dispose() }
      server.setSecureContext({ key: await readFile(otherKey), cert: await readFile(otherCert) })
      await assert.rejects(new ServerHttp(url, { secret: 'token' }, otherCert, false).request('GET', '/test'), /IP|hostname|alternative name/i)
      assert.equal(requests, 2, 'credentials must not reach a server with the wrong hostname')
    } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) }
  } finally { await rm(root, { recursive: true, force: true }) }
})
