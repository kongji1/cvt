const REGISTER_PATH = "/api/agent-identity/register";
const AGENT_REGISTER_PROXY_URL = "https://agent-register.caoo.kdns.fr/.well-known/cvt-agent-register";
const PROXY_SECRET_HEADER = "X-CVT-Agent-Proxy-Secret";
const MAX_BODY_BYTES = 16 * 1024;
const SSH_ALGORITHM = "ssh-ed25519";

function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json;charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

function safeErrorCode(value, fallback = "upstream_error") {
  const code = String(value ?? "").trim();
  return /^[a-zA-Z0-9_.:-]{1,80}$/.test(code) ? code : fallback;
}

function safeDiagnostic(value) {
  return String(value ?? "")
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/[A-Za-z0-9_=-]{40,}/g, "<redacted>")
    .slice(0, 160);
}

function decodeBase64Url(value) {
  let normalized = String(value ?? "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[a-zA-Z0-9+/]*={0,2}$/.test(normalized)) throw new Error("invalid_base64url");
  const remainder = normalized.length % 4;
  if (remainder) normalized += "=".repeat(4 - remainder);
  return atob(normalized);
}

function validateJwt(accessToken, nowSeconds = Math.trunc(Date.now() / 1000)) {
  const token = String(accessToken ?? "").trim();
  if (token.length < 20 || token.length > 12000 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    return { ok: false, code: "invalid_access_token" };
  }
  let payload;
  try {
    payload = JSON.parse(decodeURIComponent(Array.from(decodeBase64Url(token.split(".")[1]), (char) =>
      `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`).join("")));
  } catch {
    return { ok: false, code: "invalid_access_token_payload" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, code: "invalid_access_token_payload" };
  const exp = Number(payload.exp);
  if (!Number.isFinite(exp) || exp <= nowSeconds) return { ok: false, code: "expired_access_token" };
  const nbf = Number(payload.nbf);
  if (Number.isFinite(nbf) && nbf > nowSeconds + 60) return { ok: false, code: "access_token_not_yet_valid" };
  const auth = payload["https://api.openai.com/auth"];
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return { ok: false, code: "missing_openai_auth_claims" };
  const accountId = String(auth.chatgpt_account_id || auth.account_id || "").trim()
    || (String(auth.chatgpt_account_user_id || "").includes("__") ? String(auth.chatgpt_account_user_id).split("__").pop().trim() : "");
  const userId = String(auth.chatgpt_user_id || auth.user_id || "").trim();
  if (!accountId || !userId) return { ok: false, code: "missing_agent_identity_claims" };
  return { ok: true };
}

function readUint32(bytes, offset) {
  if (offset + 4 > bytes.length) return -1;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
}

function validateEd25519PublicKey(value) {
  const text = String(value ?? "").trim();
  const parts = text.split(/\s+/);
  if (parts.length !== 2 || parts[0] !== SSH_ALGORITHM || !/^[A-Za-z0-9+/]+={0,2}$/.test(parts[1])) return false;
  let bytes;
  try {
    bytes = Uint8Array.from(atob(parts[1]), (char) => char.charCodeAt(0));
  } catch {
    return false;
  }
  const algorithmLength = readUint32(bytes, 0);
  if (algorithmLength !== SSH_ALGORITHM.length) return false;
  const algorithm = new TextDecoder().decode(bytes.slice(4, 4 + algorithmLength));
  const keyLengthOffset = 4 + algorithmLength;
  const keyLength = readUint32(bytes, keyLengthOffset);
  return algorithm === SSH_ALGORITHM && keyLength === 32 && bytes.length === keyLengthOffset + 4 + keyLength;
}

async function readJsonBody(request) {
  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) return { error: "request_too_large" };
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return { error: "request_too_large" };
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? { value } : { error: "invalid_json" };
  } catch {
    return { error: "invalid_json" };
  }
}

export async function handleRegister(request, env = {}, fetchImpl = fetch) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (!origin || origin !== requestUrl.origin) return jsonResponse({ error: { code: "same_origin_required" } }, 403);
  if (request.method !== "POST") return jsonResponse({ error: { code: "method_not_allowed" } }, 405, { Allow: "POST" });
  if (!String(request.headers.get("Content-Type") || "").toLowerCase().startsWith("application/json")) {
    return jsonResponse({ error: { code: "content_type_required" } }, 415);
  }

  const parsed = await readJsonBody(request);
  if (parsed.error) return jsonResponse({ error: { code: parsed.error } }, parsed.error === "request_too_large" ? 413 : 400);
  const accessToken = String(parsed.value.access_token ?? "").trim();
  const publicKey = String(parsed.value.agent_public_key ?? "").trim();
  const jwtCheck = validateJwt(accessToken);
  if (!jwtCheck.ok) return jsonResponse({ error: { code: jwtCheck.code } }, 400);
  if (!validateEd25519PublicKey(publicKey)) return jsonResponse({ error: { code: "invalid_agent_public_key" } }, 400);
  const proxySecret = String(env?.AGENT_REGISTER_PROXY_SECRET ?? "").trim();
  if (proxySecret.length < 32 || proxySecret.length > 512) {
    return jsonResponse({ error: { code: "agent_register_proxy_not_configured" } }, 503);
  }

  let upstream;
  try {
    upstream = await fetchImpl(AGENT_REGISTER_PROXY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        [PROXY_SECRET_HEADER]: proxySecret,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        abom: {
          agent_version: "0.138.0-alpha.6",
          agent_harness_id: "codex-cli",
          running_location: "local",
        },
        agent_public_key: publicKey,
      }),
      redirect: "manual",
    });
  } catch (error) {
    const diagnostic = {
      name: safeErrorCode(error?.name, "Error"),
      cause: safeErrorCode(error?.cause?.code, "unknown"),
      message: safeDiagnostic(error?.message),
    };
    console.error("agent_register_proxy_fetch_failed", diagnostic);
    return jsonResponse({ error: { code: "upstream_unreachable" } }, 502);
  }

  let upstreamPayload = {};
  try {
    upstreamPayload = await upstream.json();
  } catch {
    upstreamPayload = {};
  }
  if (!upstream.ok) {
    const status = upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502;
    const code = safeErrorCode(upstreamPayload?.error?.code || upstreamPayload?.code);
    return jsonResponse({ error: { code } }, status);
  }
  const runtimeId = String(upstreamPayload?.agent_runtime_id ?? "").trim();
  if (!runtimeId || runtimeId.length > 256) return jsonResponse({ error: { code: "invalid_upstream_response" } }, 502);
  return jsonResponse({ agent_runtime_id: runtimeId });
}

export { validateEd25519PublicKey, validateJwt };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === REGISTER_PATH) return handleRegister(request, env);
    if (env?.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not Found", { status: 404 });
  },
};
