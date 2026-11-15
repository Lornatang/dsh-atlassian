import { AtlassianBridge } from '../../lib/bridge.js'
import { SessionStore } from '../../lib/store.js'

const [url, file, port] = process.argv.slice(2)
const logger = { info() {}, warn() {}, error() {} }
const store = new SessionStore(file)
let held
const bridge = new AtlassianBridge({ logger, register() { return () => {} } }, {
  serverName: 'atlassian', url, redirectPort: Number(port), toolCallTimeoutMs: 5000,
  expectedSite: '', authorizationTimeoutMs: 5000, autoOpenBrowser: false, store,
})

process.on('message', async ({ id, command }) => {
  try {
    let result
    if (command === 'start') {
      await bridge.start()
      result = bridge.snapshot()
    } else if (command === 'call') {
      result = await bridge.callTool('getJiraIssue', { issueIdOrKey: 'DEMO-1' })
    } else if (command === 'authorize') {
      result = await bridge.authorize()
    } else if (command === 'snapshot') {
      result = bridge.snapshot()
    } else if (command === 'dispose') {
      await bridge.dispose()
      held?.release()
      result = true
    } else if (command === 'hold') {
      held = await store.acquire()
      result = true
    } else if (command === 'patch') {
      await store.patch({ codeVerifier: 'child-verifier' })
      result = true
    } else throw new Error('unknown command')
    process.send?.({ id, result })
    if (command === 'dispose') process.disconnect()
  } catch (error) { process.send?.({ id, error: String(error?.stack ?? error) }) }
})
