import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const openaiScript = readFileSync(new URL("../public/openai-converter.js", import.meta.url), "utf8");
const identityScript = readFileSync(new URL("../public/agent-identity.js", import.meta.url), "utf8");

function jwt(payload) {
  return `${Buffer.from('{"alg":"EdDSA"}').toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

function createContext() {
  const context = vm.createContext({
    TextDecoder,
    TextEncoder,
    Uint8Array,
    atob,
    btoa,
    crypto: webcrypto,
    fetch,
    Response,
  });
  vm.runInContext(openaiScript, context, { filename: "public/openai-converter.js" });
  vm.runInContext(identityScript, context, { filename: "public/agent-identity.js" });
  return context;
}

test("Agent Identity is generated locally and registration never receives the private key", async () => {
  const context = createContext();
  const accessToken = jwt({
    exp: 4102444800,
    "https://api.openai.com/auth": {
      chatgpt_account_id: "account-1",
      chatgpt_user_id: "user-1",
    },
    "https://api.openai.com/profile": { email: "agent@example.com" },
  });
  const records = context.CVT_OPENAI.parse(JSON.stringify({ type: "codex", access_token: accessToken })).records;
  let request = null;
  const fakeFetch = async (url, init) => {
    request = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ agent_runtime_id: "runtime-1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const output = await context.CVT_AGENT_IDENTITY.create(records, {
    crypto: webcrypto,
    fetch: fakeFetch,
    now: new Date("2026-07-22T00:00:00Z"),
  });
  assert.equal(request.url, "/api/agent-identity/register");
  assert.deepEqual(Object.keys(request.body).sort(), ["access_token", "agent_public_key"]);
  assert.equal(request.body.access_token, accessToken);
  assert.equal(JSON.stringify(request.body).includes("agent_private_key"), false);
  assert.equal(JSON.stringify(request.body).includes("privateKey"), false);
  assert.match(request.body.agent_public_key, /^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/);

  const auth = JSON.parse(output.text);
  assert.equal(auth.auth_mode, "agent_identity");
  assert.equal(auth.agent_identity.agent_runtime_id, "runtime-1");
  assert.equal(auth.agent_identity.account_id, "account-1");
  assert.equal(auth.agent_identity.chatgpt_user_id, "user-1");
  assert.match(auth.agent_identity.agent_private_key, /^[A-Za-z0-9+/]+={0,2}$/);
  const privateBytes = Buffer.from(auth.agent_identity.agent_private_key, "base64");
  const imported = await webcrypto.subtle.importKey("pkcs8", privateBytes, { name: "Ed25519" }, true, ["sign"]);
  assert.equal(imported.type, "private");
});

test("existing Agent Identity exports locally without any registration request", async () => {
  const context = createContext();
  const input = {
    auth_mode: "agent_identity",
    agent_identity: {
      agent_runtime_id: "runtime-existing",
      agent_private_key: "PKCS8-BASE64",
      account_id: "account-existing",
      chatgpt_user_id: "user-existing",
    },
  };
  const records = context.CVT_OPENAI.parse(JSON.stringify(input)).records;
  let calls = 0;
  const output = await context.CVT_AGENT_IDENTITY.create(records, {
    fetch: async () => { calls += 1; throw new Error("must not run"); },
    now: new Date("2026-07-22T00:00:00Z"),
  });
  assert.equal(calls, 0);
  assert.equal(JSON.parse(output.text).agent_identity.agent_private_key, "PKCS8-BASE64");
});

test("registration errors are sanitized and never echo the access token", async () => {
  const context = createContext();
  const token = "header.payload.signature";
  await assert.rejects(
    context.CVT_AGENT_IDENTITY.register(token, `ssh-ed25519 ${Buffer.alloc(51).toString("base64")}`, async () =>
      new Response(JSON.stringify({ error: { code: "invalid_token", message: `echo ${token}` } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    ),
    (error) => !String(error.message).includes(token) && /invalid_token/.test(error.message)
  );
});
