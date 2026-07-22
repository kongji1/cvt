(() => {
  "use strict";

  const REGISTER_ENDPOINT = "/api/agent-identity/register";
  const SSH_ALGORITHM = "ssh-ed25519";
  const encoder = new TextEncoder();

  function toStandardBase64(bytes) {
    let binary = "";
    const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (const byte of input) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  function uint32Bytes(value) {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, false);
    return bytes;
  }

  function concatBytes(...parts) {
    const size = parts.reduce((total, part) => total + part.length, 0);
    const output = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      output.set(part, offset);
      offset += part.length;
    }
    return output;
  }

  function toOpenSshPublicKey(rawPublicKey) {
    const algorithm = encoder.encode(SSH_ALGORITHM);
    const key = rawPublicKey instanceof Uint8Array ? rawPublicKey : new Uint8Array(rawPublicKey);
    if (key.length !== 32) throw new Error("Ed25519 公钥长度无效");
    const blob = concatBytes(uint32Bytes(algorithm.length), algorithm, uint32Bytes(key.length), key);
    return `${SSH_ALGORITHM} ${toStandardBase64(blob)}`;
  }

  async function generateKeyPair(cryptoImpl = globalThis.crypto) {
    if (!cryptoImpl?.subtle) throw new Error("当前浏览器不支持 WebCrypto");
    let keyPair;
    try {
      keyPair = await cryptoImpl.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    } catch {
      throw new Error("当前浏览器无法生成 Ed25519 密钥");
    }
    const [pkcs8, rawPublicKey] = await Promise.all([
      cryptoImpl.subtle.exportKey("pkcs8", keyPair.privateKey),
      cryptoImpl.subtle.exportKey("raw", keyPair.publicKey),
    ]);
    return {
      privateKey: toStandardBase64(new Uint8Array(pkcs8)),
      publicKey: toOpenSshPublicKey(new Uint8Array(rawPublicKey)),
    };
  }

  function safeErrorCode(value) {
    const code = String(value ?? "").trim();
    return /^[a-zA-Z0-9_.:-]{1,80}$/.test(code) ? code : "registration_failed";
  }

  async function register(accessToken, publicKey, fetchImpl = globalThis.fetch) {
    const token = String(accessToken ?? "").trim();
    if (token.split(".").length !== 3) throw new Error("access_token 不是有效的三段式 JWT");
    if (!String(publicKey ?? "").startsWith(`${SSH_ALGORITHM} `)) throw new Error("Ed25519 公钥格式无效");
    if (typeof fetchImpl !== "function") throw new Error("当前浏览器不支持网络请求");

    let response;
    try {
      response = await fetchImpl(REGISTER_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ access_token: token, agent_public_key: publicKey }),
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
      });
    } catch {
      throw new Error("Agent Identity 注册请求失败");
    }

    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }
    if (!response.ok) {
      const code = safeErrorCode(payload?.error?.code || payload?.code);
      throw new Error(`Agent Identity 注册失败（HTTP ${response.status}，${code}）`);
    }
    const runtimeId = String(payload?.agent_runtime_id ?? "").trim();
    if (!runtimeId || runtimeId.length > 256) throw new Error("注册响应缺少 agent_runtime_id");
    return { agent_runtime_id: runtimeId };
  }

  async function create(records, dependencies = {}) {
    if (!globalThis.CVT_OPENAI) throw new Error("OpenAI 转换器尚未加载");
    const items = Array.isArray(records) ? records : [];
    if (!items.length) throw new Error("没有可生成 Agent Identity 的记录");
    const now = dependencies.now instanceof Date ? dependencies.now : new Date();
    const checks = items.map((record) => globalThis.CVT_OPENAI.validateAgentIdentityCandidate(record, now));
    const invalidIndex = checks.findIndex((check) => !check.ok);
    if (invalidIndex >= 0) throw new Error(`第 ${invalidIndex + 1} 条记录不可生成：${checks[invalidIndex].reason}`);

    const registrations = [];
    for (let index = 0; index < items.length; index += 1) {
      if (!checks[index].online) {
        registrations.push({});
        continue;
      }
      const keyPair = await generateKeyPair(dependencies.crypto || globalThis.crypto);
      const registration = await register(
        items[index].access_token,
        keyPair.publicKey,
        dependencies.fetch || globalThis.fetch
      );
      registrations.push({
        agent_runtime_id: registration.agent_runtime_id,
        agent_private_key: keyPair.privateKey,
      });
    }
    return globalThis.CVT_OPENAI.buildAgentIdentityOutput(items, registrations, now);
  }

  globalThis.CVT_AGENT_IDENTITY = Object.freeze({
    create,
    generateKeyPair,
    register,
    toOpenSshPublicKey,
  });
})();
