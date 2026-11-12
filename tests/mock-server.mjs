import { createServer } from 'node:http'

export async function startMockServer() {
  const calls = []
  const jiraAuth = `Basic ${Buffer.from('jira-user:jira-password').toString('base64')}`
  const confluenceAuth = 'Bearer confluence-token'
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const isJira = url.pathname.startsWith('/jira/')
    const isConfluence = url.pathname.startsWith('/confluence/')
    const expected = isJira ? jiraAuth : confluenceAuth
    if ((!isJira && !isConfluence) || req.headers.authorization !== expected) {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{}'); return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
    calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body })
    let result
    let status = 200
    if (url.pathname === '/jira/rest/api/2/myself') result = { name: 'jira-user' }
    else if (url.pathname === '/confluence/rest/api/user/current') result = { username: 'confluence-user' }
    else if (url.pathname === '/jira/rest/api/2/search') result = { startAt: 0, total: 1, issues: [{ id: '1', key: 'DEMO-1', fields: { summary: 'Mock issue', project: { key: 'DEMO', name: 'Demo' }, status: { name: 'To Do', statusCategory: { key: 'new', name: 'To Do' } } } }] }
    else if (url.pathname === '/jira/rest/api/2/issue/DEMO-1/transitions' && req.method === 'GET') result = { transitions: [{ id: '11', name: 'Done', to: { name: 'Done', statusCategory: { key: 'done' } } }] }
    else if (url.pathname === '/jira/rest/api/2/issue/DEMO-1/transitions' && req.method === 'POST') { status = 204; result = undefined }
    else if (url.pathname === '/jira/rest/api/2/issue/DEMO-1') result = { id: '1', key: 'DEMO-1', fields: { summary: 'Mock issue', description: 'Details', project: { key: 'DEMO' }, status: { name: 'To Do' } } }
    else if (url.pathname === '/jira/rest/api/2/project') result = [{ key: 'DEMO', name: 'Demo' }]
    else if (url.pathname === '/confluence/rest/api/content/search') result = { results: [{ id: '123', title: 'Mock page' }] }
    else if (url.pathname === '/confluence/rest/api/content/123' && req.method === 'GET') result = { id: '123', title: 'Mock page', version: { number: 2 }, body: { storage: { value: '<p>text</p>' } } }
    else if (url.pathname === '/confluence/rest/api/content/123' && req.method === 'PUT') result = { id: '123', version: { number: 3 } }
    else if (url.pathname === '/confluence/rest/api/space') result = { results: [{ key: 'DEMO' }] }
    else { status = 404; result = { message: 'not found' } }
    res.writeHead(status, { 'content-type': 'application/json' }).end(result === undefined ? undefined : JSON.stringify(result))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  return { jiraUrl: origin + '/jira', confluenceUrl: origin + '/confluence', calls, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }) }
}
