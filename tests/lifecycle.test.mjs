import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply, Config } from '../lib/index.js'
import { SessionStore, sessionFileFor } from '../lib/store.js'

const logger = { info() {}, warn() {}, error() {} }

function harness(patchPath, services) {
  const cleanups = []
  const edits = []
  let handler
  const registry = new Map(services)
  registry.set('configEditor', {
    entries: () => [{ options: { id: 'atlassian' } }],
    edit: async (entry, change) => { edits.push(change({}, undefined)) },
  })
  registry.set('webServer', { register(route) { handler = route.handler; return () => {} } })
  registry.set('connection', { requestRejection: () => undefined })
  const ctx = {
    tools: { register: () => () => {} },
    logger,
    effect(setup) { const cleanup = setup(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
    get: (name) => registry.get(name),
    on: () => () => {},
    profileContext: { patchPath },
  }
  return { ctx, cleanups, edits, handler: () => handler }
}

async function withServer(handler, run) {
  const server = createServer((req, res) => void handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try { await run(`http://127.0.0.1:${server.address().port}`) }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) }
}

test('switching endpoints destroys the credential file of the previous identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlassian-lifecycle-'))
  const patchPath = join(root, 'cordis.patch.yml')
  const oldFile = sessionFileFor('atlassian', 'server:\0', patchPath)
  const h = harness(patchPath, [])
  try {
    apply(h.ctx, Config({ mode: 'server', serverName: 'atlassian', server: { jiraUrl: '', confluenceUrl: '' } }))
    await new SessionStore(oldFile).patch({ serverCredentials: { jira: { secret: 'old-secret' } } })
    await withServer(h.handler(), async (base) => {
      const response = await fetch(`${base}/plugins/atlassian/configure`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jiraUrl: 'https://127.0.0.1:1', confluenceUrl: '', jiraCaFile: '', confluenceCaFile: '', allowInsecureHttp: false }),
      })
      assert.equal(response.status, 200)
    })
    assert.equal(h.edits.length, 1)
    for (let i = 0; i < 80; i++) {
      try { await stat(oldFile); await new Promise((resolve) => setTimeout(resolve, 25)) } catch { break }
    }
    await assert.rejects(stat(oldFile), { code: 'ENOENT' })
    const newFile = sessionFileFor('atlassian', 'server:https://127.0.0.1:1\0', patchPath)
    await assert.rejects(stat(newFile), { code: 'ENOENT' })
  } finally {
    for (const cleanup of h.cleanups.reverse()) await cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test('saving the same endpoints keeps the stored credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlassian-lifecycle-same-'))
  const patchPath = join(root, 'cordis.patch.yml')
  const identity = 'server:https://127.0.0.1:1\0'
  const file = sessionFileFor('atlassian', identity, patchPath)
  const h = harness(patchPath, [])
  try {
    await new SessionStore(file).patch({ serverCredentials: { jira: { secret: 'kept-secret' } } })
    apply(h.ctx, Config({ mode: 'server', serverName: 'atlassian', server: { jiraUrl: 'https://127.0.0.1:1', confluenceUrl: '' } }))
    await withServer(h.handler(), async (base) => {
      const response = await fetch(`${base}/plugins/atlassian/configure`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jiraUrl: 'https://127.0.0.1:1', confluenceUrl: '', jiraCaFile: '', confluenceCaFile: '', allowInsecureHttp: false }),
      })
      assert.equal(response.status, 200)
    })
    assert.equal(h.edits.length, 1)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const saved = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(saved.serverCredentials.jira.secret, 'kept-secret')
  } finally {
    for (const cleanup of h.cleanups.reverse()) await cleanup()
    await rm(root, { recursive: true, force: true })
  }
})
