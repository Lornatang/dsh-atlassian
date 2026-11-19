import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

export async function startMockMcp({ initializeDelay = 0, resourceDelay = 0, oauth = false, tokenEndpoint, rotateRefresh = false, refreshDelay = 0, staleUnauthorizedDelay = 0, refreshErrorOnce = false, dropRefreshResponse = false, clientSecretBasic = false, serverEvents = false, strictRedirect = false, failToolListOnce = false, resourceText } = {}) {
  const calls = []
  let origin
  let challenge
  let accessToken = 'first-access-token'
  let refreshToken = 'mock-refresh'
  let refreshes = 0
  let unauthorized = 0
  let registrationCount = 0
  const redirects = new Map()
  const streams = new Set()
  const definitions = [
    { name: 'getAccessibleAtlassianResources', description: 'Get authorized resources', inputSchema: { type: 'object', properties: {} } },
    { name: 'searchJiraIssuesUsingJql', description: 'Search issues', inputSchema: { type: 'object', properties: { cloudId: { type: 'string' }, jql: { type: 'string' } } } },
    { name: 'getJiraIssue', description: 'Get issue', inputSchema: { type: 'object', properties: { issueIdOrKey: { type: 'string' } } } },
  ]
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, origin).pathname
    const json = (value, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
    if (oauth && path.startsWith('/.well-known/oauth-protected-resource')) {
      json({ resource: `${origin}/mcp`, authorization_servers: [origin] }); return
    }
    if (oauth && path.startsWith('/.well-known/oauth-authorization-server')) {
      json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: tokenEndpoint || `${origin}/token`, registration_endpoint: `${origin}/register`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: [clientSecretBasic ? 'client_secret_basic' : 'none'] }); return
    }
    if (oauth && path === '/register') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const registration = JSON.parse(Buffer.concat(chunks).toString())
      const clientId = strictRedirect ? `mock-client-${++registrationCount}` : 'mock-client'
      redirects.set(clientId, registration.redirect_uris[0])
      json({ ...registration, client_id: clientId, ...(clientSecretBasic ? { client_secret: 'mock-secret', token_endpoint_auth_method: 'client_secret_basic' } : {}) }, 201); return
    }
    if (oauth && path === '/authorize') {
      const url = new URL(req.url, origin)
      if (strictRedirect && redirects.get(url.searchParams.get('client_id')) !== url.searchParams.get('redirect_uri')) { json({ error: 'invalid_redirect_uri' }, 400); return }
      challenge = url.searchParams.get('code_challenge')
      const redirect = new URL(url.searchParams.get('redirect_uri'))
      redirect.searchParams.set('state', url.searchParams.get('state'))
      redirect.searchParams.set('code', 'mock-code')
      res.writeHead(302, { location: redirect.toString() }).end(); return
    }
    if (oauth && path === '/token') {
      if (clientSecretBasic && req.headers.authorization !== `Basic ${Buffer.from('mock-client:mock-secret').toString('base64')}`) { json({ error: 'invalid_client' }, 401); return }
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const form = new URLSearchParams(Buffer.concat(chunks).toString())
      if (form.get('grant_type') === 'refresh_token') {
        refreshes++
        if (refreshDelay) await new Promise((resolve) => setTimeout(resolve, refreshDelay))
        if (refreshErrorOnce) { refreshErrorOnce = false; json({ error: 'invalid_scope' }, 400); return }
        if (form.get('refresh_token') !== refreshToken) { json({ error: 'invalid_grant' }, 400); return }
        if (rotateRefresh) refreshToken = `rotated-refresh-${refreshes}`
        if (dropRefreshResponse) { dropRefreshResponse = false; req.socket.destroy(); return }
      }
      else if (form.get('code') !== 'mock-code' || createHash('sha256').update(form.get('code_verifier') || '').digest('base64url') !== challenge) {
        json({ error: 'invalid_grant' }, 400); return
      }
      json({ access_token: accessToken, token_type: 'Bearer', refresh_token: refreshToken, expires_in: 3600 }); return
    }
    if (oauth && path === '/mcp' && req.headers.authorization !== `Bearer ${accessToken}`) {
      unauthorized++
      if (staleUnauthorizedDelay && unauthorized > 1) await new Promise((resolve) => setTimeout(resolve, staleUnauthorizedDelay))
      res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` }).end(); return
    }
    if (path === '/mcp' && req.method === 'GET' && serverEvents) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('retry: 10\n\n')
      streams.add(res)
      res.once('close', () => streams.delete(res))
      return
    }
    if (req.method === 'DELETE') { res.writeHead(204).end(); return }
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    calls.push(message)
    if (message.id === undefined) { res.writeHead(202).end(); return }
    let result
    if (message.method === 'initialize') {
      if (initializeDelay) await new Promise((resolve) => setTimeout(resolve, initializeDelay))
      result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } }
    } else if (message.method === 'tools/list') {
      if (failToolListOnce) {
        failToolListOnce = false
        json({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Tool list temporarily unavailable' } }); return
      }
      result = { tools: definitions }
    }
    else if (message.method === 'tools/call') {
      let value
      if (message.params.name === 'getAccessibleAtlassianResources') {
        if (resourceDelay) await new Promise((resolve) => setTimeout(resolve, resourceDelay))
        value = [{ id: 'mock-cloud-id', url: 'https://example.atlassian.net', name: 'Example' }]
      }
      else if (message.params.name === 'searchJiraIssuesUsingJql') value = { issues: [{ id: '1', key: 'DEMO-1', fields: { summary: 'Mock issue', project: { key: 'DEMO', name: 'Demo' }, status: { name: 'To Do', statusCategory: { key: 'new', name: 'To Do' } } } }], isLast: true }
      else value = { key: 'DEMO-1', fields: { summary: 'Mock issue' } }
      const text = message.params.name === 'getAccessibleAtlassianResources' && resourceText !== undefined ? resourceText : JSON.stringify(value)
      result = { content: [{ type: 'text', text }] }
    } else { res.writeHead(400).end(); return }
    if (!res.destroyed) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  return { url: `${origin}/mcp`, calls, setResourceText: (text) => { resourceText = text }, streams: () => streams.size, expire: () => { accessToken = 'refreshed-access-token'; for (const stream of streams) stream.end() }, revokeRefresh: () => { refreshToken = 'replacement-refresh' }, refreshes: () => refreshes, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }) }
}
