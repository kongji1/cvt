import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../public/openai-converter.js", import.meta.url), "utf8");
assert.match(html, /id="detectedBadge"/);
assert.match(html, /id="outputMode"/);
assert.match(html, /openai-converter\.js/);
assert.doesNotMatch(html, /自用中转站|瑞维亚AI|BuyCodekeyAPI|console\.buycodekey\.com|code\.revia\.top/);
assert.doesNotMatch(script, /buildCompatibilityIdToken|ensureIdTokenClaims|local_compat_signature/);

const elements = new Map();
function element(id = "") {
  return {
    id,
    addEventListener(type, listener) { this.listeners.set(type, listener); },
    click() {},
    className: "",
    disabled: false,
    files: [],
    listeners: new Map(),
    remove() {},
    textContent: "",
    value: "",
  };
}
function getElement(id) {
  if (!elements.has(id)) elements.set(id, element(id));
  return elements.get(id);
}

let clipboardText = "";
const context = {
  TextEncoder,
  TextDecoder,
  atob,
  btoa,
  crypto: webcrypto,
  document: { getElementById: getElement, body: { append() {} }, createElement: element, execCommand() {} },
  navigator: { clipboard: { async readText() { return clipboardText; }, async writeText() {} } },
  URL: { createObjectURL() { return "blob:test"; }, revokeObjectURL() {} },
  setTimeout,
};
vm.createContext(context);
vm.runInContext(script, context, { filename: "public/openai-converter.js" });
context.__convertText = context.CVT_OPENAI.convert;

function jwt(payload) {
  return `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
}
function accessToken(email, accountId, userId, exp = 1784000000) {
  return jwt({
    exp,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_user_id: userId },
    "https://api.openai.com/profile": { email },
  });
}
function atOnly(email, accountId, userId, refreshToken = "") {
  return JSON.stringify({
    type: "codex",
    access_token: accessToken(email, accountId, userId),
    refresh_token: refreshToken,
  });
}
function subAccount(email, accountId, overrides = {}) {
  return {
    name: email,
    platform: "openai",
    type: "oauth",
    credentials: {
      access_token: accessToken(email, accountId, `user-${accountId}`),
      chatgpt_account_id: accountId,
      email,
      ...overrides,
    },
  };
}

const now = new Date("2026-07-11T00:00:00.000Z");
const sessionInput = JSON.stringify({
  user: { email: "account@example.com", id: "user-1" },
  account: { id: "account-1", planType: "plus" },
  accessToken: accessToken("account@example.com", "account-1", "user-1"),
  refreshToken: "refresh-token",
});

const subResult = context.__convertText(sessionInput, "to-sub", now);
const sub2api = JSON.parse(subResult.output.text);
assert.equal(sub2api.type, "sub2api-data");
assert.equal(sub2api.version, 1);
assert.equal(sub2api.accounts[0].expires_at, undefined);
assert.equal(sub2api.accounts[0].credentials.expires_at, 1784000000);
assert.equal(sub2api.accounts[0].auto_pause_on_expired, true);
assert.equal(sub2api.accounts[0].credentials.id_token, undefined);

const expected = {
  "to-cockpit": (value) => assert.equal(value.account_id, "account-1"),
  "to-9router": (value) => { assert.equal(value.provider, "codex"); assert.equal(value.expiresAt, undefined); },
  "to-codex": (value) => { assert.equal(value.tokens.refresh_token, "refresh-token"); assert.equal(value.tokens.id_token, ""); },
  "to-axonhub": (value) => assert.equal(value.axonhub_refresh_token_missing, undefined),
  "to-codex-manager": (value) => assert.equal(value.meta.chatgpt_account_id, "account-1"),
};
for (const [mode, check] of Object.entries(expected)) check(JSON.parse(context.__convertText(sessionInput, mode, now).output.text));

for (const mode of ["to-cpa", "to-sub", "to-cockpit", "to-9router", "to-codex", "to-axonhub", "to-codex-manager"]) {
  const generated = context.__convertText(sessionInput, mode, now).output.text;
  const roundTrip = JSON.parse(context.__convertText(generated, "normalize", now).output.text);
  assert.equal(roundTrip.access_token, accessToken("account@example.com", "account-1", "user-1"), `${mode} must be readable as OpenAI credentials`);
  assert.equal(roundTrip.chatgpt_account_id, "account-1", `${mode} must preserve the ChatGPT account ID`);
}

const unsignedClaimsToken = jwt({ email: "signed@example.com" });
const signedInput = JSON.stringify({
  type: "codex",
  email: "signed@example.com",
  account_id: "account-signed",
  access_token: accessToken("signed@example.com", "account-signed", "user-signed"),
  id_token: unsignedClaimsToken,
});
const signedNormalized = JSON.parse(context.__convertText(signedInput, "normalize", now).output.text);
assert.equal(signedNormalized.id_token, unsignedClaimsToken, "original id_token must remain byte-for-byte unchanged");
assert.equal(JSON.parse(context.__convertText(signedInput, "to-cpa", now).output.text).id_token, unsignedClaimsToken);

const wrappedSub = JSON.stringify({ data: { type: "sub2api-data", version: 1, proxies: [], accounts: [subAccount("sub@example.com", "account-sub")] } });
assert.equal(JSON.parse(context.__convertText(wrappedSub, "to-codex", now).output.text).tokens.account_id, "account-sub");
assert.equal(JSON.parse(context.__convertText(wrappedSub, "to-9router", now).output.text).provider, "codex");

const cpaManifest = JSON.stringify({
  type: "cliproxyapi-auth-list",
  version: 1,
  auths: [{
    type: "codex",
    email: "manifest@example.com",
    account_id: "account-manifest",
    access_token: accessToken("manifest@example.com", "account-manifest", "user-manifest"),
  }],
});
const manifestResult = context.__convertText(cpaManifest, "to-sub", now);
assert.match(manifestResult.shape, /CPA auth 清单/);
assert.equal(JSON.parse(manifestResult.output.text).accounts[0].credentials.chatgpt_account_id, "account-manifest");

const mixedProviders = JSON.stringify({
  type: "sub2api-data",
  version: 1,
  proxies: [],
  accounts: [
    subAccount("openai@example.com", "account-openai"),
    { name: "claude@example.com", platform: "anthropic", type: "oauth", credentials: { access_token: "anthropic-token" } },
  ],
});
const mixedResult = context.__convertText(mixedProviders, "to-sub", now);
assert.equal(mixedResult.records.length, 1);
assert.equal(mixedResult.skipped.length, 1);
assert.match(mixedResult.skipped[0].reason, /不属于 OpenAI\/ChatGPT 格式域/);
assert.match(mixedResult.output.summary, /跳过 1 条/);
assert.throws(
  () => context.__convertText(JSON.stringify({ platform: "gemini", type: "oauth", credentials: { access_token: "token" } }), "normalize", now),
  /不属于 OpenAI\/ChatGPT 格式域/
);

const sameEmailAccounts = JSON.stringify({
  accounts: [subAccount("same@example.com", "account-a"), subAccount("same@example.com", "account-b")],
});
const sameEmailResult = context.__convertText(sameEmailAccounts, "to-sub", now);
assert.equal(sameEmailResult.records.length, 2, "account ID must take precedence over email when deduplicating");
assert.equal(JSON.parse(sameEmailResult.output.text).accounts.length, 2);

const metadataOnly = JSON.stringify({ platform: "chatgpt", email: "metadata@example.com", chatgpt_account_id: "metadata-account" });
assert.equal(JSON.parse(context.__convertText(metadataOnly, "normalize", now).output.text).access_token, "");
assert.throws(() => context.__convertText(metadataOnly, "to-codex", now), /必须有 access_token/);

const agentIdentity = JSON.stringify({
  platform: "openai",
  type: "oauth",
  credentials: { auth_mode: "agentidentity", agent_identity: { private_key: "must-not-leak" } },
});
assert.throws(() => context.__convertText(agentIdentity, "normalize", now), /Agent Identity/);

const noRefreshInput = atOnly("no-refresh@example.com", "account-no-refresh", "user-no-refresh");
const noRefreshAxon = JSON.parse(context.__convertText(noRefreshInput, "to-axonhub", now).output.text);
assert.equal(noRefreshAxon.tokens.refresh_token, "");
assert.equal(noRefreshAxon.axonhub_refresh_token_missing, true);
assert.doesNotMatch(JSON.stringify(noRefreshAxon), /__missing_refresh_token__/);

const multiCpa = context.__convertText(`${atOnly("first@example.com", "account-at-1", "user-at-1", "refresh-at-1")}\n${atOnly("second@example.com", "account-at-2", "user-at-2", "refresh-at-2")}`, "to-cpa", now).output;
assert.equal(multiCpa.name, "cliproxyapi-auth-files.zip");
assert.equal(multiCpa.mime, "application/zip");
assert.equal(multiCpa.parts[0][0], 0x50);
assert.equal(multiCpa.parts[0][1], 0x4b);
assert.match(multiCpa.text, /codex-first@example\.com\.json/);

const firstAtOnly = atOnly("first@example.com", "account-at-1", "user-at-1", "refresh-at-1");
const secondAtOnly = atOnly("second@example.com", "account-at-2", "user-at-2", "refresh-at-2");
const cardText = `=== \u5361\u5bc6\u5185\u5bb9 ===\n${firstAtOnly}\n${secondAtOnly}`;
const cardResult = context.__convertText(cardText, "to-sub", now);
assert.equal(cardResult.shape, "\u5361\u5bc6\u5bfc\u51fa TXT");
assert.equal(JSON.parse(cardResult.output.text).accounts.length, 2);

const capability = context.CVT_OPENAI.supportedModes(context.CVT_OPENAI.parse(sessionInput).records, now);
assert.deepEqual(Array.from(capability.modes), [
  "to-sub", "to-cpa", "to-cockpit", "to-9router", "to-codex", "to-axonhub", "to-codex-manager", "to-agent-identity", "normalize"
]);
assert.equal(capability.details["to-agent-identity"].level, "online");

const existingIdentityInput = JSON.stringify({
  auth_mode: "agent_identity",
  agent_identity: {
    agent_runtime_id: "runtime-existing",
    agent_private_key: "PKCS8-BASE64",
    account_id: "account-existing",
    chatgpt_user_id: "user-existing",
    email: "identity@example.com",
    plan_type: "plus",
  },
});
const identityParsed = context.CVT_OPENAI.parse(existingIdentityInput);
assert.match(identityParsed.shape, /Agent Identity auth\.json/);
assert.deepEqual(Array.from(context.CVT_OPENAI.supportedModes(identityParsed.records, now).modes), ["to-sub", "to-agent-identity", "normalize"]);
const identitySub = JSON.parse(context.__convertText(existingIdentityInput, "to-sub", now).output.text);
assert.equal(identitySub.accounts[0].credentials.auth_mode, "agentIdentity");
assert.equal(identitySub.accounts[0].credentials.agent_private_key, "PKCS8-BASE64");
assert.equal(identitySub.accounts[0].credentials.chatgpt_account_id, "account-existing");
const identityAuth = JSON.parse(context.__convertText(JSON.stringify(identitySub), "to-agent-identity", now).output.text);
assert.equal(identityAuth.agent_identity.agent_runtime_id, "runtime-existing");
assert.equal(identityAuth.agent_identity.agent_private_key, "PKCS8-BASE64");

const expiredInput = JSON.stringify({
  type: "codex",
  access_token: accessToken("expired@example.com", "account-expired", "user-expired", 1),
});
assert.equal(context.CVT_OPENAI.supportedModes(context.CVT_OPENAI.parse(expiredInput).records, now).modes.includes("to-agent-identity"), false);

const preservedInput = JSON.stringify({
  type: "codex",
  email: "preserved@example.com",
  access_token: accessToken("preserved@example.com", "account-preserved", "user-preserved"),
  refresh_token: "refresh-preserved",
  id_token: "id-preserved",
  subscription_expires_at: "2099-01-01T00:00:00Z",
  organization_id: "org-preserved",
  chatgpt_account_is_fedramp: true,
  openai_auth_mode: "chatgpt",
  token_type: "Bearer",
  scope: "openid profile",
});
const preservedCredentials = JSON.parse(context.__convertText(preservedInput, "to-sub", now).output.text).accounts[0].credentials;
for (const field of ["subscription_expires_at", "organization_id", "openai_auth_mode", "token_type", "scope"]) {
  assert.ok(preservedCredentials[field], `${field} must survive CPA -> sub2api`);
}
assert.equal(preservedCredentials.chatgpt_account_is_fedramp, true);

console.log("session converter compatibility checks passed");
