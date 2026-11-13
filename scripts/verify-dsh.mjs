import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { startMockMcp } from '../tests/mock-mcp.mjs'
import { startMockServer } from '../tests/mock-server.mjs'
import { verifyBrowser } from './browser-smoke.mjs'

const run = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const temp = await mkdtemp(join(tmpdir(), 'atlassian-dsh-integration-'))
const home = join(temp, 'home')
const dshHome = join(temp, 'dsh-home')
const dsh = process.env.DSH_TEST_BINARY || 'dsh'
const env = { ...process.env, HOME: home, DSH_HOME: dshHome }
delete env.DSH_PROFILE
const serverMode = process.env.DSH_TEST_MODE === 'server'
const mock = serverMode ? await startMockServer() : await startMockMcp()
let server
let output = ''
try {
  await mkdir(home, { recursive: true })
  const version = (await run(dsh, ['--version'], { env, timeout: 30000 })).stdout.trim()
  assert.equal(version, '0.2.2-rc.2', 'this integration test targets DSH 0.2.2-rc.2')
  await run(dsh, ['--profile', 'bridge-test', '--from-default-profile', 'web', '--dump-config'], { env, cwd: temp, timeout: 60000, maxBuffer: 1024 * 1024 })
  const profile = join(dshHome, 'profiles', 'bridge-test')
  const expected = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const previous = process.env.DSH_TEST_UPGRADE_FROM
  const previousName = '@lornatang/dsh-atlassian-bridge'
  const modeConfig = serverMode
    ? `    mode: server\n    server:\n      jiraUrl: '${mock.jiraUrl}'\n      confluenceUrl: '${mock.confluenceUrl}'\n      allowInsecureHttp: true\n`
    : `    url: '${mock.url}'\n    redirectPort: 0\n    autoOpenBrowser: false\n`
  const patch = `# existing profile settings\n- id: atlassian\n  config:\n    serverName: atlassian-test\n${modeConfig}    board:\n      jql: ''\n      limit: 10\n      timeoutMs: 5000\n      promptTemplate: ''\n`
  if (previous) {
    let oldSpec = previous
    if (previous === 'legacy-fixture') {
      const packed = JSON.parse((await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp, join(root, 'tests', 'fixtures', 'legacy-plugin')], { cwd: root, env, timeout: 30000 })).stdout)[0]
      oldSpec = join(temp, packed.filename)
    }
    await run(dsh, ['plugin', '--profile', 'bridge-test', 'add', oldSpec, '--registry=https://registry.npmjs.org/'], { env, cwd: temp, timeout: 240000, maxBuffer: 1024 * 1024 })
    await writeFile(join(profile, 'cordis.patch.yml'), patch)
  }
  let packageSpec = process.env.DSH_TEST_PACKAGE
  if (!packageSpec) {
    const packed = JSON.parse((await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], { cwd: root, env, timeout: 30000 })).stdout)[0]
    packageSpec = join(temp, packed.filename)
  }
  await run(dsh, ['plugin', '--profile', 'bridge-test', 'add', packageSpec, '--registry=https://registry.npmjs.org/'], { env, cwd: temp, timeout: 240000, maxBuffer: 1024 * 1024 })
  if (previous) {
    await run(dsh, ['plugin', '--profile', 'bridge-test', 'remove', previousName], { env, cwd: temp, timeout: 240000, maxBuffer: 1024 * 1024 })
    assert.equal(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), patch, 'migration must preserve profile settings')
  } else await writeFile(join(profile, 'cordis.patch.yml'), patch)
  const profilePackage = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  assert.ok(profilePackage.dependencies[expected.name])
  if (previous) assert.ok(!profilePackage.dependencies[previousName], 'migration must remove the previous package')
  const installed = JSON.parse(await readFile(join(profile, 'node_modules', ...expected.name.split('/'), 'package.json'), 'utf8'))
  assert.equal(installed.version, expected.version, 'the profile must load the version being tested')
  if (previous && serverMode) {
    const identity = `server:${mock.jiraUrl}\0${mock.confluenceUrl}`
    const digest = createHash('sha256').update(identity).digest('hex').slice(0, 12)
    const dataDir = join(profile, 'data')
    await mkdir(dataDir, { recursive: true, mode: 0o700 })
    await writeFile(join(dataDir, `atlassian-bridge-atlassian-test-${digest}.json`), JSON.stringify({ version: 1, serverCredentials: { jira: { username: 'jira-user', secret: 'jira-password' }, confluence: { secret: 'confluence-token' } } }), { mode: 0o600 })
  }
  server = spawn(dsh, ['--profile', 'bridge-test', '--no-open', '--port', '0'], { env, cwd: temp, stdio: ['ignore', 'pipe', 'pipe'] })
  server.stdout.on('data', (chunk) => { output += chunk })
  server.stderr.on('data', (chunk) => { output += chunk })
  let launch
  for (let i = 0; i < 900; i++) {
    launch = output.match(/https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0]
    if (launch) break
    if (server.exitCode !== null) throw new Error('DSH exited during startup')
    await delay(100)
  }
  assert.ok(launch, 'DSH did not print an authenticated launch URL')
  const url = new URL(launch)
  const origin = url.origin
  assert.equal((await fetch(origin + '/plugins/atlassian/status')).status, 401)
  assert.ok([401, 403].includes((await fetch(origin + '/plugins/atlassian/configure', { method: 'POST', body: '{}' })).status), 'unauthenticated configuration edits must be rejected')
  const entry = await fetch(launch, { redirect: 'manual' })
  const cookie = entry.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ')
  assert.ok(cookie, 'DSH did not issue a login cookie')
  if (serverMode && !previous) {
    const connected = await fetch(origin + '/plugins/atlassian/connect', {
      method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ jiraUsername: 'jira-user', jiraSecret: 'jira-password', confluenceSecret: 'confluence-token' }),
      signal: AbortSignal.timeout(15000),
    })
    assert.equal(connected.status, 200)
    const value = await connected.json()
    assert.equal(value.status, 'ready', 'self-hosted credentials did not connect')
    assert.ok(!JSON.stringify(value).includes('jira-password') && !JSON.stringify(value).includes('confluence-token'))
  }
  let status
  for (let i = 0; i < 300; i++) {
    const response = await fetch(origin + '/plugins/atlassian/status', { headers: { cookie }, signal: AbortSignal.timeout(10000) })
    if (response.status === 200) {
      status = await response.json()
      if (status.status === 'ready') break
    }
    await delay(100)
  }
  assert.equal(status?.status, 'ready', 'the MCP bridge did not become ready')
  assert.equal(status.toolCount, serverMode ? 14 : 3)
  assert.ok((await readdir(join(profile, 'data'))).some((name) => name.startsWith('atlassian-bridge-atlassian-test-')), 'credentials must be stored under the active profile')
  const boardResponse = await fetch(origin + '/plugins/atlassian/board', { headers: { cookie }, signal: AbortSignal.timeout(10000) })
  assert.equal(boardResponse.status, 200)
  const board = await boardResponse.json()
  assert.equal(board.issues[0].key, 'DEMO-1')
  const bundle = await readFile(join(profile, 'node_modules', ...expected.name.split('/'), 'lib', 'client.js'), 'utf8')
  assert.ok(bundle.includes(expected.name))
  assert.match(bundle, /jira-board/)
  await verifyBrowser(launch, temp, serverMode)
  if (serverMode) {
    const response = await fetch(origin + '/plugins/atlassian/status', { headers: { cookie }, signal: AbortSignal.timeout(10000) })
    const single = await response.json()
    assert.equal(single.mode, 'server')
    assert.equal(single.configuration.jiraUrl, '')
    assert.equal(single.configuration.confluenceUrl, mock.confluenceUrl)
    assert.equal(single.status, 'ready')
    assert.equal(single.toolCount, 6)
    const patch = await readFile(join(profile, 'cordis.patch.yml'), 'utf8')
    assert.match(patch, /confluenceUrl:/)
    const cloud = await fetch(origin + '/plugins/atlassian/configure', {
      method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ jiraUrl: '', confluenceUrl: '', jiraCaFile: '', confluenceCaFile: '', allowInsecureHttp: false }),
      signal: AbortSignal.timeout(15000),
    })
    assert.equal(cloud.status, 200, 'clearing both service URLs must select Cloud')
    let cloudStatus
    for (let i = 0; i < 150; i++) {
      const current = await fetch(origin + '/plugins/atlassian/status', { headers: { cookie }, signal: AbortSignal.timeout(10000) })
      if (current.status === 200) {
        cloudStatus = await current.json()
        if (cloudStatus.mode !== 'server' && cloudStatus.configuration?.jiraUrl === '' && cloudStatus.configuration?.confluenceUrl === '') break
      }
      await delay(100)
    }
    assert.notEqual(cloudStatus?.mode, 'server')
    assert.equal(cloudStatus?.configuration?.jiraUrl, '')
    assert.equal(cloudStatus?.configuration?.confluenceUrl, '')
    assert.match(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), /https:\/\/mcp\.atlassian\.com\/v1\/mcp/)
    console.log('DSH: clearing both service URLs selected the official Cloud endpoint.')
  }
  console.log(`DSH 0.2.2-rc.2: package installation, startup, request fence, ${serverMode ? 'Server REST' : 'MCP'} tools and mock Jira board passed.`)
} catch (error) {
  // Do not print the launch URL, cookies, credentials, or configuration.
  const diagnostics = output.split('\n').filter((line) => /atlassian|warning|error/i.test(line) && !/token|https?:\/\//i.test(line)).slice(-20)
  if (diagnostics.length) process.stderr.write(diagnostics.join('\n') + '\n')
  throw error
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = new Promise((resolve) => server.once('exit', resolve))
    server.kill('SIGTERM')
    await Promise.race([exited, delay(5000)])
    if (server.exitCode === null && server.signalCode === null) { server.kill('SIGKILL'); await exited }
  }
  await mock.close()
  await rm(temp, { recursive: true, force: true, maxRetries: 3 })
}
