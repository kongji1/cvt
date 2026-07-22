import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../public/session/index.html", import.meta.url), "utf8");
const script = html.match(/<script>\s*([\s\S]*?)\s*<\/script>\s*<\/body>/)?.[1];
assert.ok(script, "expected one inline page script");
assert.match(html, /href="https:\/\/chatgpt\.com\/api\/auth\/session"/);
assert.match(html, /target="_blank" rel="noopener noreferrer"/);
assert.match(html, /id="import-session-clipboard"/);

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
vm.runInContext(`${script}\nglobalThis.__convertText = convertText; globalThis.__importSessionFromClipboard = importSessionFromClipboard;`, context, { filename: "public/session/index.html" });

function jwt(payload) {
  return `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
}
function atOnly(email, accountId, userId, refreshToken) {
  return JSON.stringify({
    type: "codex",
    access_token: jwt({
      exp: 1784000000,
      "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_user_id: userId },
      "https://api.openai.com/profile": { email },
    }),
    refresh_token: refreshToken,
  });
}

const now = new Date("2026-07-11T00:00:00.000Z");
const input = JSON.stringify({
  user: { email: "account@example.com", id: "user-1" },
  account: { id: "account-1", planType: "plus" },
  accessToken: jwt({ exp: 1784000000, "https://api.openai.com/auth": { chatgpt_account_id: "account-1", chatgpt_user_id: "user-1" } }),
  refreshToken: "refresh-token",
});

const sub2api = JSON.parse(context.__convertText(input, "to-sub", now).output.text);
assert.equal(sub2api.accounts[0].expires_at, undefined);
assert.equal(sub2api.accounts[0].credentials.expires_at, undefined);
assert.equal(sub2api.accounts[0].auto_pause_on_expired, undefined);

const expected = {
  "to-cockpit": (value) => assert.equal(value.account_id, "account-1"),
  "to-9router": (value) => { assert.equal(value.provider, "codex"); assert.equal(value.expiresAt, undefined); },
  "to-codex": (value) => assert.equal(value.tokens.refresh_token, "refresh-token"),
  "to-axonhub": (value) => assert.equal(value.axonhub_refresh_token_placeholder, undefined),
  "to-codex-manager": (value) => assert.equal(value.meta.chatgpt_account_id, "account-1"),
};
for (const [mode, check] of Object.entries(expected)) check(JSON.parse(context.__convertText(input, mode, now).output.text));

const firstAtOnly = atOnly("first@example.com", "account-at-1", "user-at-1", "refresh-at-1");
const atOnlySub = JSON.parse(context.__convertText(firstAtOnly, "to-sub", now).output.text);
assert.equal(atOnlySub.accounts[0].name, "first@example.com");
assert.equal(atOnlySub.accounts[0].credentials.chatgpt_account_id, "account-at-1");

const secondAtOnly = atOnly("second@example.com", "account-at-2", "user-at-2", "refresh-at-2");
const cardText = `=== \u5361\u5bc6\u5185\u5bb9 ===\n${firstAtOnly}\n${secondAtOnly}`;
const cardResult = context.__convertText(cardText, "to-sub", now);
assert.equal(cardResult.shape, "\u5361\u5bc6\u5bfc\u51fa TXT");
assert.equal(JSON.parse(cardResult.output.text).accounts.length, 2);
const cardHeadingResult = context.__convertText(`\u5361\u5bc6\u5bfc\u51fa\n${firstAtOnly}`, "to-sub", now);
assert.equal(cardHeadingResult.shape, "\u5361\u5bc6\u5bfc\u51fa TXT");
assert.equal(JSON.parse(cardHeadingResult.output.text).accounts.length, 1);

getElement("mode").value = "to-sub";
clipboardText = firstAtOnly;
await context.__importSessionFromClipboard();
assert.equal(getElement("src").value, firstAtOnly);
assert.equal(JSON.parse(getElement("out").textContent).accounts[0].name, "first@example.com");
assert.match(getElement("msg").textContent, /\u526a\u8d34\u677f/);

console.log("converter checks passed");
