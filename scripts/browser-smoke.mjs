import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { launchChrome } from './chrome-launch.mjs'
import { dismissKnownOnboarding } from './browser-ui.mjs'

/** Exercise the installed client in an isolated Chrome profile, when available. */
export async function verifyBrowser(launchUrl, temp, serverMode = false) {
  const chromePath = process.env.CHROME_PATH || [
    '/usr/bin/google-chrome', '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find((path) => existsSync(path))
  if (!chromePath) {
    if (process.env.CI) throw new Error('Chrome is required in CI; set CHROME_PATH')
    console.log('Chrome unavailable; browser smoke check skipped.')
    return
  }
  const chrome = await launchChrome(chromePath, temp)
  let socket
  try {
    const response = await fetch(`http://127.0.0.1:${chrome.port}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw new Error(`Chrome could not create a test tab: HTTP ${response.status}`)
    const target = await response.json()
    socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Chrome debugging connection timed out')), 15000)
      const finish = (error) => {
        clearTimeout(timer)
        socket.removeEventListener('open', opened)
        socket.removeEventListener('error', failed)
        socket.removeEventListener('close', closed)
        if (error) reject(error)
        else resolve()
      }
      const opened = () => finish()
      const failed = () => finish(new Error('Chrome debugging connection failed'))
      const closed = () => finish(new Error('Chrome debugging connection closed before opening'))
      socket.addEventListener('open', opened, { once: true })
      socket.addEventListener('error', failed, { once: true })
      socket.addEventListener('close', closed, { once: true })
    })
    const pending = new Map()
    let id = 0
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const waiter = pending.get(message.id)
      if (waiter) {
        pending.delete(message.id)
        clearTimeout(waiter.timer)
        if (message.error) waiter.reject(new Error(message.error.message))
        else waiter.resolve(message.result)
      }
    })
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const next = ++id
      const timer = setTimeout(() => { pending.delete(next); reject(new Error(`browser command timed out: ${method}`)) }, 15000)
      pending.set(next, { resolve, reject, timer })
      socket.send(JSON.stringify({ id: next, method, params }))
    })
    const evaluate = async (expression) => {
      const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.text)
      return response.result.value
    }
    const capture = async (name) => {
      if (!process.env.DSH_TEST_SCREENSHOT_DIR) return
      await mkdir(process.env.DSH_TEST_SCREENSHOT_DIR, { recursive: true })
      const frame = await send('Page.captureScreenshot', { format: 'png' })
      await writeFile(join(process.env.DSH_TEST_SCREENSHOT_DIR, `${name}.png`), Buffer.from(frame.data, 'base64'))
    }
    await send('Page.enable')
    if (process.env.DSH_TEST_THEME) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: process.env.DSH_TEST_THEME }] })
    if (process.env.DSH_TEST_LANGUAGE) {
      const version = await send('Browser.getVersion')
      await send('Network.setUserAgentOverride', { userAgent: version.userAgent, acceptLanguage: process.env.DSH_TEST_LANGUAGE })
    }
    await send('Page.navigate', { url: launchUrl })
    let clicked = false
    for (let i = 0; i < 300; i++) {
      clicked = await evaluate(`(() => {
        const hit = [...document.querySelectorAll('button,[role=button],a')].find((node) => {
          const label = (node.getAttribute('aria-label') || node.textContent || '').trim();
          return label === 'Jira' || label.startsWith('Jira \u770b\u677f');
        });
        if (!hit) return false; hit.click(); return true;
      })()`)
      if (clicked) break
      await delay(100)
    }
    assert.ok(clicked, 'Jira sidebar entry did not render')
    let card = false
    for (let i = 0; i < 200; i++) {
      card = await evaluate(`!![...document.querySelectorAll('[data-dsh-jira-card]')].find((node) => node.textContent.includes('DEMO-1'))`)
      if (card) break
      await delay(100)
    }
    assert.ok(card, 'mock Jira issue did not render on the board')
    await capture('jira-board')
    console.log('Chrome: Jira sidebar and mock issue card rendered.')
    if (serverMode) {
      await evaluate(`document.querySelector('[data-dsh-jira-card] input[type=checkbox]')?.click()`)
      let actions = false
      for (let i = 0; i < 50; i++) {
        actions = await evaluate(`document.body.innerText.includes('Send to current session') && document.body.innerText.includes('Send to new session')`)
        if (actions) break
        await delay(100)
      }
      assert.ok(actions, 'issue handoff actions did not render')
      await evaluate(`document.querySelector('[data-dsh-jira-card]')?.click()`)
      let detail = false
      for (let i = 0; i < 100; i++) {
        detail = await evaluate(`!!document.querySelector('.dab-detail') && document.querySelector('.dab-detail').innerText.includes('Mock issue')`)
        if (detail) break
        await delay(100)
      }
      assert.ok(detail, 'issue details did not render')
      await evaluate(`document.querySelector('.dab-detail button')?.click()`)
      for (let i = 0; i < 50; i++) {
        if (await evaluate(`(${dismissKnownOnboarding.toString()})()`) === 'none') break
        await delay(100)
      }
      await capture('jira-board-ready')
      let opened = false
      for (let i = 0; i < 200; i++) {
        const action = await evaluate(`(() => {
          const onboarding = (${dismissKnownOnboarding.toString()})();
          if (onboarding !== 'none') return { kind: onboarding };
          const visible = (node) => {
            const r = node.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
          };
          const settings = [...document.querySelectorAll('button,[role=button],a,[role=menuitem]')].find((node) => {
            const label = (node.getAttribute('aria-label') || node.textContent || '').trim();
            return visible(node) && (label.startsWith('\u8bbe\u7f6e') || label.startsWith('Settings') || label.includes('\u6253\u5f00\u8bbe\u7f6e'));
          });
          if (settings) { settings.click(); return { kind: 'opened' }; }
          const account = [...document.querySelectorAll('button')].find((node) => /\u8d26\u53f7\u83dc\u5355|Account menu/i.test(node.getAttribute('aria-label') || ''));
          if (!account || !visible(account)) {
            const toggle = [...document.querySelectorAll('button')].find((node) => /\u6253\u5f00\u4fa7\u8fb9\u680f|Open sidebar/i.test(node.getAttribute('aria-label') || '') && visible(node));
            if (toggle) toggle.click();
            return { kind: 'waiting' };
          }
          if (account.getAttribute('aria-expanded') === 'true') return { kind: 'waiting' };
          const r = account.getBoundingClientRect();
          return { kind: 'account', x: r.x + r.width / 2, y: r.y + r.height / 2 };
        })()`)
        if (action.kind === 'opened') { opened = true; break }
        if (action.kind === 'account') {
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: action.x, y: action.y })
          await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: action.x, y: action.y })
        }
        await delay(action.kind === 'account' ? 300 : 100)
      }
      if (!opened) {
        const details = await evaluate(`(() => {
          const button = [...document.querySelectorAll('button')].find((node) => /\u8d26\u53f7\u83dc\u5355|Account menu/i.test(node.getAttribute('aria-label') || ''));
          const r = button?.getBoundingClientRect();
          const cover = r && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return { account: r && { x:r.x, y:r.y, width:r.width, height:r.height, expanded:button.getAttribute('aria-expanded'), cover:cover?.outerHTML.slice(0,300) }, candidates: Array.from(document.querySelectorAll('button,[role=button],a,[role=menuitem]')).map((n) => ({ text: (n.textContent || '').trim().slice(0, 60), aria: n.getAttribute('aria-label'), title: n.getAttribute('title') })).filter((v) => v.text || v.aria || v.title).slice(-50), dialogs: Array.from(document.querySelectorAll('[role=dialog]')).map((n) => ({ text:n.innerText.slice(0, 300), open:n.getAttribute('data-state'), hidden:n.getAttribute('aria-hidden') })) };
        })()`)
        throw new Error(`settings entry did not render: ${JSON.stringify(details)}`)
      }
      let selected = false
      for (let i = 0; i < 100; i++) {
        selected = await evaluate(`(() => {
          const hit = [...document.querySelectorAll('button,[role=button],a,li')].find((node) => (node.textContent || '').trim() === 'Atlassian');
          if (!hit) return false; hit.click(); return true;
        })()`)
        if (selected) break
        await delay(100)
      }
      assert.ok(selected, 'Atlassian settings entry did not render')
      let fields = false
      for (let i = 0; i < 100; i++) {
        fields = await evaluate(`!!document.querySelector('[data-dab-settings]') && document.body.innerText.includes('Confluence') && document.querySelectorAll('input[type=password]').length === 2`)
        if (fields) break
        await delay(100)
      }
      assert.ok(fields, 'self-hosted credential fields did not render')
      if (process.env.DSH_TEST_SCREENSHOT_DIR) {
        const theme = await evaluate(`(() => {
          const root = document.querySelector('.dab-root');
          const nodes = [root, root?.parentElement, document.body, document.documentElement].filter(Boolean);
          return nodes.map(node => { const s = getComputedStyle(node); return { tag: node.tagName, className: String(node.className), color: s.color, background: s.backgroundColor, colorScheme: s.colorScheme, variables: [...s].filter(k => k.startsWith('--') && /foreground|background|surface|text|border|color-scheme/i.test(k)).slice(0,60).map(k => [k,s.getPropertyValue(k).trim()]) }; });
        })()`)
        console.log('Theme diagnostics:', JSON.stringify(theme))
      }
      await capture('atlassian-settings')
      console.log('Chrome: self-hosted settings and masked credential fields rendered.')
      const edited = await evaluate(`(() => {
        const label = [...document.querySelectorAll('label')].find((node) => node.textContent.trim() === 'Jira URL');
        const field = label?.querySelector('input');
        if (!field) return false;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, '');
        field.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`)
      assert.ok(edited, 'editable service URL did not render')
      let saveReady = false
      for (let i = 0; i < 50; i++) {
        saveReady = await evaluate(`!![...document.querySelectorAll('button')].find((node) => node.textContent.trim() === 'Save URLs' && !node.disabled)`)
        if (saveReady) break
        await delay(100)
      }
      assert.ok(saveReady, 'changing a service URL did not enable save')
      await evaluate(`[...document.querySelectorAll('button')].find((node) => node.textContent.trim() === 'Save URLs').click()`)
      let singleService = false
      for (let i = 0; i < 200; i++) {
        singleService = await evaluate(`!!document.querySelector('[aria-label="Confluence credentials"]') && !document.querySelector('[aria-label="Jira credentials"]')`)
        if (singleService) break
        await delay(100)
      }
      assert.ok(singleService, 'saving a single-service configuration did not reload the plugin')
      await evaluate(`(() => {
        const field = document.querySelector('[aria-label="Confluence credentials"] input[type=password]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, 'confluence-token');
        field.dispatchEvent(new Event('input', { bubbles: true }));
        [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === 'Connect').click();
      })()`)
      let connected = false
      for (let i = 0; i < 150; i++) {
        connected = await evaluate(`document.querySelector('[role=status]')?.textContent.includes('Connected')`)
        if (connected) break
        await delay(100)
      }
      assert.ok(connected, 'single-service configuration did not connect')
      console.log('Chrome: saved a Confluence-only URL and connected successfully.')
    }
  } finally {
    socket?.close()
    await chrome.close()
  }
}
