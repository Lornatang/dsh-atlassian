import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Config, DEFAULT_CLOUD_URL, configureEndpoints } from '../lib/config.js'

const current = Config({ serverName: 'my-atlassian', board: { limit: 42 } })
const defaults = { jiraUrl: '', confluenceUrl: '', jiraCaFile: '', confluenceCaFile: '', allowInsecureHttp: false }

test('blank service URLs select official Cloud and a single URL enables only that service', () => {
  const cloud = configureEndpoints({ ...current, url: 'https://custom.example/mcp' }, defaults)
  assert.equal(cloud.mode, 'cloud')
  assert.equal(cloud.url, DEFAULT_CLOUD_URL)
  const server = configureEndpoints(current, { ...defaults, confluenceUrl: 'https://wiki.example.test/confluence/' })
  assert.equal(server.mode, 'server')
  assert.equal(server.server.jiraUrl, '')
  assert.equal(server.server.confluenceUrl, 'https://wiki.example.test/confluence')
  assert.equal(server.serverName, 'my-atlassian')
  assert.equal(server.board.limit, 42)
})

test('connection settings reject unsafe URLs and require explicit HTTP consent', () => {
  for (const jiraUrl of ['javascript:alert(1)', 'https://user:password@example.test/', 'https://example.test/?token=x', 'https://example.test/#fragment']) {
    assert.throws(() => configureEndpoints(current, { ...defaults, jiraUrl }), /HTTP\(S\)|Invalid/)
  }
  assert.throws(() => configureEndpoints(current, { ...defaults, jiraUrl: 'http://jira.example.test' }), /plaintext/)
  assert.equal(configureEndpoints(current, { ...defaults, jiraUrl: 'http://jira.example.test/', allowInsecureHttp: true }).server.jiraUrl, 'http://jira.example.test')
})
