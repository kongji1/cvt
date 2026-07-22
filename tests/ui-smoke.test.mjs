import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
const pageScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
const openaiScript = readFileSync(new URL('../public/openai-converter.js', import.meta.url), 'utf8')

function element() {
  return {
    checked: true,
    classList: { add() {}, remove() {}, toggle() {} },
    disabled: false,
    files: [],
    listeners: {},
    textContent: '',
    value: '',
    _innerHTML: '',
    addEventListener(type, listener) { this.listeners[type] = listener },
    appendChild() {},
    click() {},
    remove() {},
    select() {},
    setAttribute() {},
    get innerHTML() { return this._innerHTML },
    set innerHTML(value) {
      this._innerHTML = value
      const first = value.match(/<option value="([^"]*)"/)
      if (first) this.value = first[1]
    }
  }
}

test('unified page auto-detects CPA Codex and only registers Agent Identity after an explicit click', async () => {
  const elements = new Map()
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, element())
    return elements.get(id)
  }
  const context = vm.createContext({
    Blob,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    URL: { createObjectURL() { return 'blob:test' }, revokeObjectURL() {} },
    atob,
    btoa,
    clearTimeout,
    console,
    document: {
      body: { appendChild() {} },
      createElement: element,
      execCommand() {},
      getElementById: get
    },
    navigator: { clipboard: { readText: async () => '', writeText: async () => {} } },
    setTimeout
  })

  vm.runInContext(openaiScript, context)
  vm.runInContext(pageScript, context)
  const accessToken = `${Buffer.from('{"alg":"EdDSA"}').toString('base64url')}.${Buffer.from(JSON.stringify({
    exp: 4102444800,
    'https://api.openai.com/auth': { chatgpt_account_id: 'account-smoke', chatgpt_user_id: 'user-smoke' }
  })).toString('base64url')}.signature`
  get('sourceInput').value = JSON.stringify({
    type: 'codex',
    email: 'smoke@example.com',
    account_id: 'account-smoke',
    access_token: accessToken,
    refresh_token: 'refresh-smoke'
  })
  context.convert()

  assert.equal(get('detectedBadge').textContent, 'CPA Codex')
  assert.match(get('outputMode').innerHTML, /to-codex/)
  assert.match(get('outputMode').innerHTML, /to-agent-identity/)
  assert.equal(get('statSupported').textContent, '9')
  assert.equal(JSON.parse(get('outputJson').value).accounts[0].name, 'smoke@example.com')

  let registrations = 0
  context.CVT_AGENT_IDENTITY = {
    async create() {
      registrations += 1
      return {
        text: JSON.stringify({ auth_mode: 'agent_identity', agent_identity: { agent_runtime_id: 'runtime-smoke' } }),
        name: 'auth.json', mime: 'application/json;charset=utf-8', parts: [], summary: 'generated'
      }
    }
  }
  get('outputMode').value = 'to-agent-identity'
  context.convert()
  assert.equal(registrations, 0, 'auto conversion must not register a Runtime')
  await get('generateAgentBtn').listeners.click()
  assert.equal(registrations, 1, 'registration only starts after the explicit button click')
})
