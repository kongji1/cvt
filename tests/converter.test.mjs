import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/)
assert.ok(scriptMatch, 'index.html should contain the converter script')

const eventBindingMarker = 'els.dirCpaToSub.addEventListener'
const coreSource = scriptMatch[1].slice(0, scriptMatch[1].indexOf(eventBindingMarker))
assert.ok(coreSource.length > 0, 'converter core should be found before UI event bindings')

const elements = new Map()
const elementStub = () => ({
  checked: true,
  disabled: false,
  value: '',
  textContent: '',
  classList: { add() {}, remove() {}, toggle() {} },
  setAttribute() {}
})

const context = vm.createContext({
  Blob,
  TextEncoder,
  TextDecoder,
  URL,
  Uint8Array,
  atob,
  clearTimeout,
  console,
  document: {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, elementStub())
      return elements.get(id)
    }
  },
  setTimeout
})

vm.runInContext(`${coreSource}
globalThis.converter = {
  buildCPA,
  buildSub2API,
  convertCPARecord,
  convertSubAccount,
  parseInputText,
  validateSub2APIDataHeader
}`, context)

const converter = context.converter
const plain = (value) => JSON.parse(JSON.stringify(value))

test('CLIProxyAPI xai OAuth converts to a native sub2api grok account', () => {
  const result = plain(converter.buildSub2API([{
    name: 'xai-user.json',
    value: {
      type: 'xai',
      access_token: 'access-xai',
      refresh_token: 'refresh-xai',
      id_token: 'id-xai',
      token_type: 'Bearer',
      expired: '2099-01-01T00:00:00Z',
      email: 'xai@example.com',
      sub: 'subject-1',
      subscription_tier: 'SuperGrok',
      entitlement_status: 'active',
      base_url: 'https://api.x.ai/v1',
      auth_kind: 'oauth'
    }
  }]))

  assert.equal(result.accountCount, 1)
  const account = result.output.accounts[0]
  assert.equal(account.platform, 'grok')
  assert.equal(account.type, 'oauth')
  assert.equal(account.concurrency, 1)
  assert.equal(account.priority, 1)
  assert.equal(account.rate_multiplier, 1)
  assert.equal(account.auto_pause_on_expired, true)
  assert.equal(account.credentials.access_token, 'access-xai')
  assert.equal(account.credentials.refresh_token, 'refresh-xai')
  assert.equal(account.credentials.sub, 'subject-1')
  assert.equal(account.credentials.client_id, 'b1a00492-073a-47ea-816f-4c329264a828')
  assert.equal(account.credentials.scope, 'openid profile email offline_access grok-cli:access api:access')
  assert.equal(account.credentials.base_url, 'https://cli-chat-proxy.grok.com/v1')
  assert.deepEqual(account.extra, {
    email: 'xai@example.com',
    subscription_tier: 'SuperGrok',
    entitlement_status: 'active'
  })
})

test('bare sub2api-data restores grok auth fields but deliberately drops proxy details', () => {
  const payload = {
    type: 'sub2api-data',
    version: 1,
    exported_at: '2026-07-14T00:00:00Z',
    proxies: [{
      proxy_key: 'proxy-1',
      name: 'local',
      protocol: 'socks5',
      host: '127.0.0.1',
      port: 1080,
      username: 'user',
      password: 'pass',
      status: 'active'
    }],
    accounts: [{
      name: 'Grok account',
      platform: 'grok',
      type: 'oauth',
      proxy_key: 'proxy-1',
      credentials: {
        access_token: 'access-grok',
        refresh_token: 'refresh-grok',
        id_token: 'id-grok',
        token_type: 'Bearer',
        expires_at: '2099-01-01T00:00:00Z',
        email: 'grok@example.com',
        sub: 'subject-2',
        base_url: 'https://cli-chat-proxy.grok.com/v1',
        using_api: false
      },
      concurrency: 1,
      priority: 1
    }]
  }

  const parsed = plain(converter.parseInputText(JSON.stringify(payload), 'sub2api.json'))
  assert.equal(parsed.entries.length, 1)

  const result = plain(converter.buildCPA(parsed.entries))
  assert.equal(result.accountCount, 1)
  assert.equal(result.proxyCount, 0)
  const auth = result.cpaFiles[0].data
  assert.equal(auth.type, 'xai')
  assert.equal(auth.email, 'grok@example.com')
  assert.equal(auth.sub, 'subject-2')
  assert.equal(auth.auth_kind, 'oauth')
  assert.equal(auth.base_url, 'https://api.x.ai/v1')
  assert.equal(auth.token_endpoint, 'https://auth.x.ai/oauth2/token')
  assert.equal(auth.using_api, false)
  assert.equal(auth.expired, '2099-01-01T00:00:00Z')
  assert.equal(auth.proxy_url, undefined)
  assert.equal(JSON.stringify(result.output).includes('pass'), false)
})

test('OpenAI fields and standard OAuth defaults remain compatible', () => {
  const result = plain(converter.buildSub2API([{
    name: 'codex.json',
    value: {
      type: 'codex',
      access_token: 'access-codex',
      refresh_token: 'refresh-codex',
      account_id: 'account-1',
      subscription_expires_at: '2099-12-31T00:00:00Z',
      chatgpt_account_is_fedramp: true,
      expired: '2099-01-01T00:00:00Z'
    }
  }]))

  const account = result.output.accounts[0]
  assert.equal(account.platform, 'openai')
  assert.equal(account.concurrency, 10)
  assert.equal(account.credentials.chatgpt_account_id, 'account-1')
  assert.equal(account.credentials.subscription_expires_at, '2099-12-31T00:00:00Z')
  assert.equal(account.credentials.chatgpt_account_is_fedramp, true)
})

test('sub2api account name remains the CPA email fallback', () => {
  const result = plain(converter.buildCPA([{
    name: 'sub2api-account.json',
    value: {
      name: 'user@example.com__ws_account-id',
      platform: 'openai',
      type: 'oauth',
      credentials: {
        access_token: 'access-openai',
        chatgpt_account_id: 'account-id',
        expires_at: '2099-01-01T00:00:00Z'
      },
      priority: 1
    }
  }]))

  assert.equal(result.accountCount, 1)
  assert.equal(result.cpaFiles[0].data.email, 'user@example.com__ws_account-id')
})

test('Codex OAuth uses the latest native account-hash filename', () => {
  const accountID = 'account-id-for-filename'
  const payload = Buffer.from(JSON.stringify({
    email: 'CaseSensitive@example.com',
    'https://api.openai.com/auth': {
      chatgpt_account_id: accountID,
      chatgpt_plan_type: ' Team Plan '
    }
  })).toString('base64url')
  const result = plain(converter.buildCPA([{
    name: 'sub2api-account.json',
    value: {
      name: 'fallback@example.com',
      platform: 'openai',
      type: 'oauth',
      credentials: {
        access_token: 'access-openai',
        id_token: `header.${payload}.signature`,
        email: 'CaseSensitive@example.com',
        chatgpt_account_id: accountID,
        plan_type: 'Team Plan'
      }
    }
  }]))

  const hash = createHash('sha256').update(accountID).digest('hex').slice(0, 8)
  assert.equal(result.cpaFiles[0].name, `codex-${hash}-CaseSensitive@example.com-team-plan.json`)
})

test('sub2api Agent Identity is safely skipped without leaking its private key', () => {
  const privateKey = 'PRIVATE-KEY-MUST-NOT-LEAK'
  const result = plain(converter.buildCPA([{
    name: 'agent-identity.json',
    value: {
      name: 'agent@example.com',
      platform: 'openai',
      type: 'oauth',
      credentials: {
        auth_mode: 'agentIdentity',
        agent_runtime_id: 'runtime-1',
        agent_private_key: privateKey,
        chatgpt_account_id: 'account-1',
        chatgpt_user_id: 'user-1'
      }
    }
  }]))

  assert.equal(result.accountCount, 0)
  assert.match(result.skipped[0].reason, /Agent Identity/)
  assert.equal(JSON.stringify(result).includes(privateKey), false)
})

test('legacy CPA Gemini is forward-only and no invalid latest CPA file is emitted', () => {
  const forward = plain(converter.buildSub2API([{
    name: 'gemini.json',
    value: {
      type: 'gemini',
      project_id: 'project-1',
      token: {
        access_token: 'access-gemini',
        refresh_token: 'refresh-gemini'
      }
    }
  }]))
  assert.equal(forward.accountCount, 1)
  assert.equal(forward.output.accounts[0].platform, 'gemini')

  const reverse = plain(converter.buildCPA([{
    name: 'gemini-account.json',
    value: {
      name: 'Gemini account',
      platform: 'gemini',
      type: 'oauth',
      credentials: { access_token: 'access-gemini' }
    }
  }]))
  assert.equal(reverse.accountCount, 0)
  assert.match(reverse.skipped[0].reason, /已移除 Gemini auth/)
})

test('sub2api data headers follow the latest type and version validation', () => {
  assert.equal(converter.validateSub2APIDataHeader({
    type: 'sub2api-data',
    version: 1,
    skipped_shadows: 2,
    proxies: [],
    accounts: []
  }), '')
  assert.match(converter.validateSub2APIDataHeader({
    type: 'unknown-data',
    version: 1,
    proxies: [],
    accounts: []
  }), /不支持的 sub2api data type/)
  assert.match(converter.validateSub2APIDataHeader({
    type: 'sub2api-data',
    version: 2,
    proxies: [],
    accounts: []
  }), /不支持的 sub2api data version/)
  assert.equal(converter.validateSub2APIDataHeader({
    name: 'single account',
    platform: 'openai',
    type: 'oauth',
    credentials: { access_token: 'access' }
  }), '')
})
