import assert from "node:assert/strict";
import test from "node:test";
import { handleRegister, validateEd25519PublicKey, validateJwt } from "../src/index.js";

function jwt(payload) {
  return `${Buffer.from('{"alg":"EdDSA"}').toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

function accessToken(exp = 4102444800) {
  return jwt({
    exp,
    "https://api.openai.com/auth": {
      chatgpt_account_id: "account-1",
      chatgpt_user_id: "user-1",
    },
  });
}

function sshPublicKey() {
  const algorithm = Buffer.from("ssh-ed25519");
  const raw = Buffer.alloc(32, 7);
  const blob = Buffer.alloc(4 + algorithm.length + 4 + raw.length);
  blob.writeUInt32BE(algorithm.length, 0);
  algorithm.copy(blob, 4);
  blob.writeUInt32BE(raw.length, 4 + algorithm.length);
  raw.copy(blob, 8 + algorithm.length);
  return `ssh-ed25519 ${blob.toString("base64")}`;
}

function request(body, headers = {}) {
  return new Request("https://cvt.caoo.kdns.fr/api/agent-identity/register", {
    method: "POST",
    headers: {
      Origin: "https://cvt.caoo.kdns.fr",
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const workerEnv = { AGENT_REGISTER_PROXY_SECRET: "test-secret-that-is-long-enough-for-worker-tests" };

test("Worker validates input and forwards only the fixed US registration-proxy payload", async () => {
  const token = accessToken();
  const publicKey = sshPublicKey();
  assert.equal(validateEd25519PublicKey(publicKey), true);
  assert.equal(validateJwt(token, 1784678400).ok, true);
  let upstream = null;
  const response = await handleRegister(request({ access_token: token, agent_public_key: publicKey }), workerEnv, async (url, init) => {
    upstream = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ agent_runtime_id: "runtime-1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { agent_runtime_id: "runtime-1" });
  assert.equal(upstream.url, "https://agent-register.caoo.kdns.fr/.well-known/cvt-agent-register");
  assert.equal(upstream.init.headers.Authorization, `Bearer ${token}`);
  assert.equal(upstream.init.headers["X-CVT-Agent-Proxy-Secret"], workerEnv.AGENT_REGISTER_PROXY_SECRET);
  assert.equal(upstream.init.redirect, "manual");
  assert.deepEqual(Object.keys(upstream.body).sort(), ["abom", "agent_public_key"]);
  assert.equal(upstream.body.agent_public_key, publicKey);
  assert.equal(JSON.stringify(upstream.body).includes(token), false);
  assert.equal(JSON.stringify(upstream.body).includes("private"), false);
  assert.equal(JSON.stringify(upstream.body).includes(workerEnv.AGENT_REGISTER_PROXY_SECRET), false);
  assert.equal(upstream.body.abom.agent_harness_id, "codex-cli");
});

test("Worker rejects cross-origin, expired JWT and malformed public keys before upstream", async () => {
  let calls = 0;
  const noUpstream = async () => { calls += 1; throw new Error("must not run"); };

  const crossOrigin = request({ access_token: accessToken(), agent_public_key: sshPublicKey() }, { Origin: "https://evil.example" });
  assert.equal((await handleRegister(crossOrigin, workerEnv, noUpstream)).status, 403);

  const expired = request({ access_token: accessToken(1), agent_public_key: sshPublicKey() });
  const expiredResponse = await handleRegister(expired, workerEnv, noUpstream);
  assert.equal(expiredResponse.status, 400);
  assert.deepEqual(await expiredResponse.json(), { error: { code: "expired_access_token" } });

  const invalidKey = request({ access_token: accessToken(), agent_public_key: "ssh-ed25519 invalid" });
  assert.equal((await handleRegister(invalidKey, workerEnv, noUpstream)).status, 400);
  assert.equal(calls, 0);
});

test("Worker fails closed when the registration-proxy secret is missing", async () => {
  let calls = 0;
  const response = await handleRegister(
    request({ access_token: accessToken(), agent_public_key: sshPublicKey() }),
    {},
    async () => { calls += 1; throw new Error("must not run"); },
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: { code: "agent_register_proxy_not_configured" } });
  assert.equal(calls, 0);
});

test("Worker redacts upstream messages and tokens from errors", async () => {
  const token = accessToken();
  const response = await handleRegister(request({ access_token: token, agent_public_key: sshPublicKey() }), workerEnv, async () =>
    new Response(JSON.stringify({ error: { code: "unsupported_country_region_territory", message: `secret ${token}` } }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    })
  );
  const text = await response.text();
  assert.equal(response.status, 403);
  assert.match(text, /unsupported_country_region_territory/);
  assert.equal(text.includes(token), false);
  assert.equal(text.includes("secret"), false);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});
