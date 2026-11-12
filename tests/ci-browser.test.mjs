import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { launchChrome } from '../scripts/chrome-launch.mjs'
import { dismissKnownOnboarding } from '../scripts/browser-ui.mjs'

async function fakeChrome(temp, mode) {
  const executable = join(temp, 'fake-chrome')
  const count = join(temp, 'attempts')
  const script = `#!/usr/bin/env node
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const count = ${JSON.stringify(count)}
const mode = ${JSON.stringify(mode)}
fs.appendFileSync(count, String(process.pid) + '\\n')
const attempts = fs.readFileSync(count, 'utf8').trim().split('\\n').length
if (mode === 'always-fail' || (mode === 'fail-first' && attempts === 1)) {
  console.error('ERROR: synthetic startup failure token=private-token')
  console.error('ERROR: diagnostic endpoint https://example.test/?secret=private-value')
  process.exit(23)
}
if (mode === 'hang-first' && attempts === 1) setInterval(() => {}, 1000)
else {
  const profile = process.argv.find((arg) => arg.startsWith('--user-data-dir=')).split('=').slice(1).join('=')
  const server = http.createServer((_req, res) => res.writeHead(200).end('{}'))
  server.listen(0, '127.0.0.1', () => {
    setTimeout(() => fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), server.address().port + '\\n/fake'), 100)
  })
}
`
  await writeFile(executable, script)
  await chmod(executable, 0o755)
  return { executable, count }
}

test('Chrome startup retries a failed process with an isolated profile', { skip: process.platform === 'win32' }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-chrome-retry-'))
  const warnings = []
  try {
    const { executable, count } = await fakeChrome(temp, 'fail-first')
    const chrome = await launchChrome(executable, temp, { startupTimeoutMs: 10000, pollIntervalMs: 20, onRetry: (message) => warnings.push(message) })
    try {
      assert.equal((await fetch(`http://127.0.0.1:${chrome.port}/json/version`)).status, 200)
      assert.equal((await readFile(count, 'utf8')).trim().split('\n').length, 2)
      assert.equal(warnings.length, 1)
      assert.match(warnings[0], /synthetic startup failure/)
      assert.doesNotMatch(warnings[0], /private-token|private-value|https:\/\/example/)
    } finally { await chrome.close() }
    assert.equal((await readdir(temp)).filter((name) => name.startsWith('chrome-')).length, 0)
  } finally { await rm(temp, { recursive: true, force: true, maxRetries: 3 }) }
})

test('Chrome startup times out and cleans up before retrying', { skip: process.platform === 'win32' }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-chrome-timeout-'))
  try {
    const { executable, count } = await fakeChrome(temp, 'hang-first')
    const chrome = await launchChrome(executable, temp, { startupTimeoutMs: 5000, pollIntervalMs: 20, onRetry: () => {} })
    const pids = (await readFile(count, 'utf8')).trim().split('\n').map(Number)
    assert.equal(pids.length, 2)
    assert.throws(() => process.kill(pids[0], 0), { code: 'ESRCH' })
    await chrome.close()
    assert.throws(() => process.kill(pids[1], 0), { code: 'ESRCH' })
  } finally { await rm(temp, { recursive: true, force: true, maxRetries: 3 }) }
})

test('Chrome startup reports bounded, redacted failures and missing executables', { skip: process.platform === 'win32' }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-chrome-error-'))
  try {
    const { executable, count } = await fakeChrome(temp, 'always-fail')
    await assert.rejects(launchChrome(executable, temp, { startupTimeoutMs: 10000, pollIntervalMs: 20, onRetry: () => {} }), (error) => {
      assert.match(error.message, /attempt 1\/2[\s\S]*attempt 2\/2/)
      assert.match(error.message, /synthetic startup failure/)
      assert.doesNotMatch(error.message, /private-token|private-value|https:\/\/example/)
      return true
    })
    assert.equal((await readFile(count, 'utf8')).trim().split('\n').length, 2)
    let retried = false
    await assert.rejects(launchChrome(join(temp, 'missing'), temp, { startupTimeoutMs: 3000, onRetry: () => { retried = true } }), /ENOENT/)
    assert.equal(retried, false)
    assert.equal((await readdir(temp)).filter((name) => name.startsWith('chrome-')).length, 0)
  } finally { await rm(temp, { recursive: true, force: true, maxRetries: 3 }) }
})

function dialog(text, buttonSpecs) {
  const entry = { innerText: text, hidden: false, clicked: [] }
  entry.getAttribute = (name) => name === 'aria-hidden' && entry.hidden ? 'true' : null
  entry.getClientRects = () => entry.hidden ? [] : [{}]
  const buttons = buttonSpecs.map(({ text = '', label = '' }) => ({
    textContent: text, disabled: false,
    getAttribute: (name) => name === 'aria-label' && label ? label : null,
    getClientRects: () => [{}],
    click: () => { entry.clicked.push(text || label); entry.hidden = true },
  }))
  entry.querySelectorAll = () => buttons
  return entry
}

test('only recognized onboarding dialogs are dismissed as they appear', () => {
  const unrelated = dialog('Confirm your choice', [{ text: 'Continue' }])
  const preview = dialog('Preview Notice', [{ text: 'Continue' }])
  const welcome = dialog('Get started', [{ label: 'Close' }])
  const doc = { querySelectorAll: () => [unrelated, preview, ...(preview.hidden ? [welcome] : [])] }
  assert.equal(dismissKnownOnboarding(doc), 'dismissed')
  assert.equal(dismissKnownOnboarding(doc), 'dismissed')
  assert.equal(dismissKnownOnboarding(doc), 'none')
  assert.deepEqual(unrelated.clicked, [])
  const ambiguous = dialog('Get started', [{}, {}])
  assert.equal(dismissKnownOnboarding({ querySelectorAll: () => [ambiguous] }), 'waiting')
  assert.deepEqual(ambiguous.clicked, [])
  const chinese = dialog('\u9884\u89c8\u7248\u8bf4\u660e', [{ text: '\u7ee7\u7eed' }])
  assert.equal(dismissKnownOnboarding({ querySelectorAll: () => [chinese] }), 'dismissed')
})
