(() => {
  "use strict";
    const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
    const DEFAULT_PRIVACY_MODE = "training_off";
    const DEFAULT_PLAN_TYPE = "free";
    const AGENT_IDENTITY_AUTH_MODES = new Set(["agentidentity", "agent_identity"]);
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    function firstText(...values) {
      for (const value of values) {
        const text = String(value ?? "").trim();
        if (text) return text;
      }
      return "";
    }

    function readObject(value) {
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    }

    function coerceTimestamp(value) {
      if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
      const text = String(value ?? "").trim();
      if (!text) return 0;
      if (/^-?\d+$/.test(text)) return Math.max(0, Number.parseInt(text, 10));
      const parsed = Date.parse(text);
      return Number.isNaN(parsed) ? 0 : Math.max(0, Math.trunc(parsed / 1000));
    }

    function expiresAtFromItem(item, accessPayload) {
      return coerceTimestamp(
        firstText(
          accessPayload?.exp,
          item.expires,
          item.expiresAt,
          item.expires_at,
          item.expired
        )
      );
    }

    function looksLikeEmail(value) {
      const text = String(value ?? "").trim();
      if (!text || /\s/.test(text)) return false;
      const parts = text.split("@");
      return parts.length === 2 && Boolean(parts[0]) && Boolean(parts[1]);
    }

    function bytesToBase64Url(bytes) {
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    }

    function base64UrlToBytes(value) {
      let normalized = String(value ?? "").replace(/-/g, "+").replace(/_/g, "/");
      const remainder = normalized.length % 4;
      if (remainder) normalized += "=".repeat(4 - remainder);
      const binary = atob(normalized);
      return Uint8Array.from(binary, (char) => char.charCodeAt(0));
    }

    function jsonToBase64Url(value) {
      return bytesToBase64Url(encoder.encode(JSON.stringify(value)));
    }

    function decodeJwtPayload(token) {
      try {
        const parts = String(token ?? "").split(".");
        if (parts.length < 2) return {};
        const parsed = JSON.parse(decoder.decode(base64UrlToBytes(parts[1])));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
      } catch {
        return {};
      }
    }

    function extractAuth(payload) {
      return readObject(payload?.["https://api.openai.com/auth"]);
    }

    function extractProfile(payload) {
      return readObject(payload?.["https://api.openai.com/profile"]);
    }

    function extractAccountIdFromAuth(auth) {
      const accountId = firstText(auth?.chatgpt_account_id, auth?.account_id);
      if (accountId) return accountId;
      const accountUserId = firstText(auth?.chatgpt_account_user_id);
      if (accountUserId.includes("__")) return firstText(accountUserId.split("__").pop());
      return "";
    }

    function extractOrganizationId(idAuth, accessAuth) {
      const direct = firstText(idAuth?.organization_id, accessAuth?.organization_id);
      if (direct) return direct;
      const organizations = Array.isArray(idAuth?.organizations) ? idAuth.organizations : [];
      const preferred = organizations.find((org) => org?.is_default) || organizations[0];
      return firstText(preferred?.id);
    }

    function finalizeRecord(record) {
      const item = { ...record };
      item.credential_kind = item.credential_kind === "agent_identity" ? "agent_identity" : "oauth";
      item.chatgpt_account_id = firstText(item.chatgpt_account_id, item.account_id);
      item.project_id = firstText(item.project_id, item.workspace_id);
      item.workspace_id = firstText(item.workspace_id, item.project_id);
      item.client_id = firstText(item.client_id, DEFAULT_CLIENT_ID);
      item.plan_type = firstText(item.plan_type, DEFAULT_PLAN_TYPE);
      item.privacy_mode = firstText(item.privacy_mode, DEFAULT_PRIVACY_MODE);
      item.openai_oauth_responses_websockets_v2_enabled = Boolean(item.openai_oauth_responses_websockets_v2_enabled);
      item.openai_oauth_responses_websockets_v2_mode = firstText(item.openai_oauth_responses_websockets_v2_mode, "off");
      item.disabled = Boolean(item.disabled);
      item.id_token = firstText(item.id_token);
      item.agent_runtime_id = firstText(item.agent_runtime_id);
      item.agent_private_key = firstText(item.agent_private_key);
      item.task_id = firstText(item.task_id);
      return item;
    }

    const CHATGPT_PLATFORM_NAMES = new Set(["openai", "chatgpt", "codex"]);
    const NON_CHATGPT_PLATFORM_NAMES = new Set(["anthropic", "claude", "gemini", "gemini-cli", "antigravity", "grok", "xai"]);

    function chatGPTCompatibilityError(input) {
      const item = readObject(input);
      const credentials = readObject(item.credentials);
      const platform = firstText(item.platform).toLowerCase();
      const provider = firstText(item.provider).toLowerCase();
      const type = firstText(item.type).toLowerCase();

      for (const [field, value] of [["platform", platform], ["provider", provider], ["type", type]]) {
        if (NON_CHATGPT_PLATFORM_NAMES.has(value)) {
          return `${field}=${value} 不属于 OpenAI/ChatGPT 格式域，请改用多供应商 CPA ↔ sub2api 通道`;
        }
      }
      if (platform && !CHATGPT_PLATFORM_NAMES.has(platform)) return `不支持的 OpenAI/ChatGPT platform：${platform}`;
      if (provider && !CHATGPT_PLATFORM_NAMES.has(provider)) return `不支持的 OpenAI/ChatGPT provider：${provider}`;

      const authMode = firstText(
        item.auth_mode,
        item.openai_auth_mode,
        credentials.auth_mode,
        credentials.openai_auth_mode
      ).toLowerCase();
      const hasAgentIdentity = AGENT_IDENTITY_AUTH_MODES.has(authMode)
        || type === "agentidentity"
        || type === "agent_identity"
        || Boolean(credentials.agent_identity && typeof credentials.agent_identity === "object")
        || Boolean(credentials.agentIdentity && typeof credentials.agentIdentity === "object")
        || Boolean(item.agent_identity && typeof item.agent_identity === "object")
        || Boolean(item.agentIdentity && typeof item.agentIdentity === "object");
      if (hasAgentIdentity) return "";

      if (platform === "openai" && type && !new Set(["oauth", "openai", "chatgpt", "codex"]).has(type)) {
        return `sub2api OpenAI type=${type} 不是可互转的 OAuth 凭证`;
      }
      return "";
    }

    function normalizeRecord(input) {
      const item = readObject(input);
      if (!Object.keys(item).length || Array.isArray(item.accounts)) return null;

      const tokens = readObject(item.tokens);
      const token = readObject(item.token);
      const credentials = readObject(item.credentials);
      const extra = readObject(item.extra);
      const meta = readObject(item.meta);
      const agentIdentity = readObject(
        item.agent_identity || item.agentIdentity || credentials.agent_identity || credentials.agentIdentity ||
        (AGENT_IDENTITY_AUTH_MODES.has(firstText(item.auth_mode, item.openai_auth_mode, credentials.auth_mode, credentials.openai_auth_mode).toLowerCase()) ? credentials : null)
      );
      const credentialKind = Object.keys(agentIdentity).length ? "agent_identity" : "oauth";

      const idToken = firstText(item.id_token, item.idToken, credentials.id_token, credentials.idToken, token.id_token, token.idToken, tokens.id_token, tokens.idToken);
      const accessToken = firstText(item.access_token, item.accessToken, credentials.access_token, credentials.accessToken, token.access_token, token.accessToken, tokens.access_token, tokens.accessToken);
      const idPayload = decodeJwtPayload(idToken);
      const accessPayload = decodeJwtPayload(accessToken);
      const idAuth = extractAuth(idPayload);
      const accessAuth = extractAuth(accessPayload);
      const accessProfile = extractProfile(accessPayload);
      const user = readObject(item.user);
      const account = readObject(item.account);
      const providerSpecificData = readObject(item.providerSpecificData);
      const expiresAt = coerceTimestamp(firstText(
        accessPayload?.exp,
        item.expires,
        item.expiresAt,
        item.expires_at,
        item.expired,
        credentials.expires_at,
        credentials.expired
      ));

      const email = firstText(
        item.email,
        user.email,
        meta.label,
        extra.email,
        credentials.email,
        providerSpecificData.email,
        item.name,
        idPayload.email,
        accessProfile.email
      );
      const loginIdentity = firstText(item.login_identity);

      const record = {
        version: Number.parseInt(item.version || 1, 10) || 1,
        credential_kind: credentialKind,
        source_format: detectInputFormat(item),
        platform: firstText(item.platform, "chatgpt"),
        email: firstText(agentIdentity.email, email),
        password: firstText(item.password),
        login_identity: loginIdentity,
        phone: firstText(item.phone),
        access_token: accessToken,
        refresh_token: firstText(item.refresh_token, item.refreshToken, credentials.refresh_token, credentials.refreshToken, token.refresh_token, token.refreshToken, tokens.refresh_token, tokens.refreshToken),
        id_token: idToken,
        session_token: firstText(item.session_token, item.sessionToken, credentials.session_token, credentials.sessionToken, tokens.session_token, tokens.sessionToken),
        client_id: firstText(item.client_id, credentials.client_id, DEFAULT_CLIENT_ID),
        chatgpt_account_id: firstText(
          agentIdentity.account_id,
          agentIdentity.accountId,
          agentIdentity.chatgpt_account_id,
          item.chatgpt_account_id,
          item.chatgptAccountId,
          item.account_id,
          tokens.account_id,
          tokens.accountId,
          meta.chatgpt_account_id,
          meta.chatgptAccountId,
          account.id,
          providerSpecificData.chatgptAccountId,
          providerSpecificData.chatgpt_account_id,
          credentials.chatgpt_account_id,
          credentials.account_id,
          extractAccountIdFromAuth(idAuth),
          extractAccountIdFromAuth(accessAuth)
        ),
        chatgpt_user_id: firstText(
          agentIdentity.chatgpt_user_id,
          agentIdentity.chatgptUserId,
          item.chatgpt_user_id,
          item.chatgptUserId,
          user.id,
          item.user_id,
          providerSpecificData.chatgptUserId,
          providerSpecificData.chatgpt_user_id,
          credentials.chatgpt_user_id,
          idAuth.chatgpt_user_id,
          idAuth.user_id,
          accessAuth.chatgpt_user_id,
          accessAuth.user_id
        ),
        organization_id: firstText(item.organization_id, credentials.organization_id, extractOrganizationId(idAuth, accessAuth)),
        project_id: firstText(item.project_id, credentials.project_id, item.workspace_id, credentials.workspace_id, meta.workspace_id, meta.workspaceId, idAuth.project_id, accessAuth.project_id),
        workspace_id: firstText(item.workspace_id, credentials.workspace_id, item.project_id, credentials.project_id, meta.workspace_id, meta.workspaceId, idAuth.project_id, accessAuth.project_id),
        created_at: coerceTimestamp(firstText(item.created_at, item.createdAt)),
        last_used: coerceTimestamp(firstText(item.last_used, item.updatedAt)),
        expired: expiresAt,
        status: firstText(item.status),
        source: firstText(item.source, item.notes, item.provider === "codex" && item.authType === "oauth" ? "9router" : item.accessToken ? "chatgpt_web_session" : tokens.access_token ? "codex_input" : credentials.access_token ? "sub_bundle_input" : ""),
        disabled: Boolean(item.disabled) || item.isActive === false,
        auth_provider: firstText(item.auth_provider, item.authProvider),
        account_claims_email: firstText(item.account_claims_email, extra.email, idPayload.email, accessProfile.email, email),
        plan_type: firstText(item.plan_type, item.planType, account.plan_type, account.planType, providerSpecificData.chatgpt_plan_type, providerSpecificData.chatgptPlanType, credentials.plan_type, idAuth.chatgpt_plan_type, accessAuth.chatgpt_plan_type, DEFAULT_PLAN_TYPE),
        privacy_mode: firstText(item.privacy_mode, extra.privacy_mode, DEFAULT_PRIVACY_MODE),
        openai_oauth_responses_websockets_v2_enabled: Boolean(
          item.openai_oauth_responses_websockets_v2_enabled ||
          extra.openai_oauth_responses_websockets_v2_enabled
        ),
        openai_oauth_responses_websockets_v2_mode: firstText(
          item.openai_oauth_responses_websockets_v2_mode,
          extra.openai_oauth_responses_websockets_v2_mode,
          "off"
        ),
        subscription_expires_at: firstText(item.subscription_expires_at, credentials.subscription_expires_at),
        chatgpt_account_is_fedramp: Boolean(
          agentIdentity.chatgpt_account_is_fedramp ??
          agentIdentity.chatgptAccountIsFedramp ??
          item.chatgpt_account_is_fedramp ??
          credentials.chatgpt_account_is_fedramp
        ),
        openai_auth_mode: firstText(item.openai_auth_mode, credentials.openai_auth_mode),
        auth_mode: firstText(item.auth_mode, credentials.auth_mode),
        token_type: firstText(item.token_type, credentials.token_type, token.token_type, tokens.token_type),
        scope: firstText(item.scope, credentials.scope, token.scope, tokens.scope),
        agent_runtime_id: firstText(agentIdentity.agent_runtime_id, agentIdentity.agentRuntimeId, credentials.agent_runtime_id),
        agent_private_key: firstText(agentIdentity.agent_private_key, agentIdentity.agentPrivateKey, credentials.agent_private_key),
        task_id: firstText(agentIdentity.task_id, agentIdentity.taskId, credentials.task_id),
      };

      if (record.login_identity && !record.phone && !looksLikeEmail(record.login_identity)) record.phone = record.login_identity;
      if (!record.email) record.email = firstText(record.account_claims_email, record.chatgpt_account_id, "unknown-account");
      if (record.credential_kind === "agent_identity" && (!record.agent_runtime_id || !record.agent_private_key || !record.chatgpt_account_id || !record.chatgpt_user_id)) {
        return null;
      }
      return finalizeRecord(record);
    }

    function appendInputObject(value, items) {
      const root = readObject(value);
      const data = readObject(root.data);
      const body = Array.isArray(data.accounts) || Array.isArray(data.auths) ? data : root;
      if (Array.isArray(body.accounts)) {
        items.push(...body.accounts.filter((item) => item && typeof item === "object" && !Array.isArray(item)));
        return "SUB bundle";
      }
      if (Array.isArray(body.auths)) {
        items.push(...body.auths.filter((item) => item && typeof item === "object" && !Array.isArray(item)));
        return "CPA auth 清单";
      }
      if (Object.keys(body).length) items.push(body);
      return "";
    }

    const SOURCE_FORMAT_LABELS = Object.freeze({
      "sub2api-agent-identity": "sub2api Agent Identity",
      sub2api: "sub2api OpenAI OAuth",
      "agent-identity": "Codex Agent Identity auth.json",
      session: "ChatGPT Web Session",
      "9router": "9router OAuth",
      axonhub: "AxonHub auth.json",
      "codex-cli": "Codex CLI auth.json",
      "codex-manager": "Codex-Manager",
      "cockpit-nested": "Cockpit 嵌套 JSON",
      "cockpit-flat": "Cockpit JSON",
      cpa: "CPA Codex",
      "codex-auth": "Codex Auth",
      unified: "OpenAI Unified JSON"
    });

    function detectInputFormat(input) {
      const item = readObject(input);
      const credentials = readObject(item.credentials);
      const authMode = firstText(item.auth_mode, item.openai_auth_mode, credentials.auth_mode, credentials.openai_auth_mode).toLowerCase();
      const hasAgentIdentity = AGENT_IDENTITY_AUTH_MODES.has(authMode)
        || Boolean(item.agent_identity && typeof item.agent_identity === "object")
        || Boolean(item.agentIdentity && typeof item.agentIdentity === "object")
        || Boolean(credentials.agent_identity && typeof credentials.agent_identity === "object")
        || Boolean(credentials.agentIdentity && typeof credentials.agentIdentity === "object")
        || Boolean(credentials.agent_runtime_id && credentials.agent_private_key);

      if (credentials && Object.keys(credentials).length) {
        if (hasAgentIdentity) return "sub2api-agent-identity";
        return "sub2api";
      }
      if (hasAgentIdentity) return "agent-identity";
      if (typeof item.accessToken === "string" && (Object.keys(readObject(item.user)).length || Object.keys(readObject(item.account)).length)) return "session";
      if (typeof item.accessToken === "string" && (item.provider === "codex" || Object.keys(readObject(item.providerSpecificData)).length)) return "9router";
      if (authMode === "chatgpt" && Object.keys(readObject(item.tokens)).length && (item.axonhub_refresh_token_missing !== undefined || item.axonhub_refresh_token_placeholder !== undefined || item.axonhub_note !== undefined)) return "axonhub";
      if (authMode === "chatgpt" && Object.keys(readObject(item.tokens)).length && (item.tokens.account_id !== undefined || Object.prototype.hasOwnProperty.call(item, "OPENAI_API_KEY"))) return "codex-cli";
      if (Object.keys(readObject(item.tokens)).length && Object.keys(readObject(item.meta)).length) return "codex-manager";
      if (Object.keys(readObject(item.tokens)).length && typeof item.tokens.access_token === "string" && (item.account_id !== undefined || item.expired !== undefined || item.last_used !== undefined || item.created_at !== undefined) && authMode !== "chatgpt") return "cockpit-nested";
      if (item.type === "codex" && typeof item.access_token === "string" && !Object.keys(readObject(item.tokens)).length) {
        const cpaMarker = item.session_token !== undefined || item.chatgpt_account_id !== undefined || item.chatgpt_user_id !== undefined || item.plan_type !== undefined || item.chatgpt_plan_type !== undefined || item.subscription_expires_at !== undefined || item.openai_auth_mode !== undefined;
        return cpaMarker ? "cpa" : "cockpit-flat";
      }
      if (Object.keys(readObject(item.tokens)).length && typeof item.tokens.access_token === "string") return "codex-auth";
      return "unified";
    }

    function detectInputShape(item) {
      return SOURCE_FORMAT_LABELS[detectInputFormat(item)] || SOURCE_FORMAT_LABELS.unified;
    }

    function parseInputItems(text) {
      const trimmed = String(text ?? "").trim();
      if (!trimmed) return { items: [], shape: "空输入" };

      let root = null;
      try {
        root = JSON.parse(trimmed);
      } catch {
        root = null;
      }

      const rawLines = trimmed.split(/\r?\n/);
      const cardExport = /^(?:\u5361\u5bc6\u5bfc\u51fa)|===\s*\u5361\u5bc6\u5185\u5bb9\s*===/.test(rawLines[0].trim());
      const lines = cardExport ? rawLines.slice(1) : rawLines;
      const items = [];
      let shape = cardExport ? "\u5361\u5bc6\u5bfc\u51fa TXT" : "JSONL";

      if (root && typeof root === "object" && !Array.isArray(root)) {
        const collectionShape = appendInputObject(root, items);
        shape = `${collectionShape || detectInputShape(items[0])} JSON`;
      } else if (Array.isArray(root)) {
        let collectionShape = "";
        for (const value of root) {
          if (!value || typeof value !== "object" || Array.isArray(value)) continue;
          collectionShape = appendInputObject(value, items) || collectionShape;
        }
        shape = `${collectionShape || detectInputShape(items[0])} JSON 数组`;
      } else {
        for (const [index, rawLine] of lines.entries()) {
          const line = rawLine.trim();
          if (!line || line.startsWith("#")) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              const collectionShape = appendInputObject(parsed, items);
              if (collectionShape) shape = cardExport ? "\u5361\u5bc6\u5bfc\u51fa TXT" : `${collectionShape} JSONL`;
            }
          } catch (error) {
            const lineNumber = index + (cardExport ? 2 : 1);
            throw new Error(`\u7b2c ${lineNumber} \u884c\u4e0d\u662f\u6709\u6548 JSON：${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (!cardExport) {
          if (!/bundle|清单/.test(shape)) shape = `${detectInputShape(items[0])} JSONL`;
        }
      }

      return { items, shape };
    }

    function normalizeRecordsFromText(text) {
      const { items, shape } = parseInputItems(text);
      const recordMap = new Map();
      const skipped = [];

      for (const [index, item] of items.entries()) {
        const source = firstText(item?.email, item?.name, item?.meta?.label, `第 ${index + 1} 条`);
        const compatibilityError = chatGPTCompatibilityError(item);
        if (compatibilityError) {
          skipped.push({ source, reason: compatibilityError });
          continue;
        }
        const record = normalizeRecord(item);
        if (!record) {
          const detectedFormat = detectInputFormat(item);
          const reason = detectedFormat === "agent-identity" || detectedFormat === "sub2api-agent-identity"
            ? "Agent Identity 缺少 agent_runtime_id、agent_private_key、account_id 或 chatgpt_user_id"
            : "无法识别为 OpenAI/ChatGPT 凭证记录";
          skipped.push({ source, reason });
          continue;
        }

        const accountId = firstText(record.chatgpt_account_id).trim();
        const email = firstText(record.email).trim().toLowerCase();
        const key = accountId ? `account:${accountId}` : email ? `email:${email}` : `record:${crypto.randomUUID()}`;
        recordMap.set(key, record);
      }

      return { records: [...recordMap.values()], shape, skipped };
    }

    function toIsoUtc8(date) {
      const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
      return shifted.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " +0800");
    }

    function sanitizeFilename(value, fallback) {
      const text = firstText(value, fallback).replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_").replace(/\s+/g, "_");
      return text.slice(0, 90) || fallback;
    }

    function exportFileName(count, ext, now = new Date()) {
      const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
      return `chatgpt_${count}_${stamp}.${ext}`;
    }

    function buildCpaPayload(record, now = new Date()) {
      const item = finalizeRecord(record);
      if (item.credential_kind !== "oauth") throw new Error("Agent Identity 不能伪装成 CPA OAuth 凭证");
      const expiresAt = firstText(item.expired) ? item.expired : coerceTimestamp(decodeJwtPayload(item.access_token).exp);
      const payload = {
        type: "codex",
        email: item.email,
        expired: expiresAt ? toIsoUtc8(new Date(expiresAt * 1000)) : "",
        account_id: firstText(item.chatgpt_account_id),
        chatgpt_account_id: firstText(item.chatgpt_account_id),
        chatgpt_user_id: firstText(item.chatgpt_user_id),
        plan_type: firstText(item.plan_type, DEFAULT_PLAN_TYPE),
        disabled: Boolean(item.disabled),
        access_token: item.access_token,
        session_token: item.session_token,
        last_refresh: toIsoUtc8(now),
        refresh_token: item.refresh_token,
      };
      if (item.id_token) payload.id_token = item.id_token;
      for (const key of [
        "subscription_expires_at", "token_type", "scope", "organization_id",
        "openai_auth_mode", "auth_mode"
      ]) {
        if (item[key] !== "" && item[key] !== undefined) payload[key] = item[key];
      }
      if (item.chatgpt_account_is_fedramp) payload.chatgpt_account_is_fedramp = true;
      return payload;
    }

    function buildSubAccount(record) {
      const item = finalizeRecord(record);
      if (item.credential_kind === "agent_identity") {
        const credentials = {
          auth_mode: "agentIdentity",
          agent_runtime_id: item.agent_runtime_id,
          agent_private_key: item.agent_private_key,
          chatgpt_account_id: item.chatgpt_account_id,
          chatgpt_user_id: item.chatgpt_user_id,
          chatgpt_account_is_fedramp: Boolean(item.chatgpt_account_is_fedramp),
        };
        if (item.task_id) credentials.task_id = item.task_id;
        if (item.email) credentials.email = item.email;
        if (item.plan_type) credentials.plan_type = item.plan_type;
        return {
          name: item.email || item.chatgpt_account_id,
          platform: "openai",
          type: "oauth",
          credentials,
          extra: { email: item.email, source: "codex_agent_identity" },
          concurrency: 10,
          priority: 1,
          rate_multiplier: 1,
        };
      }
      const expiresAt = firstText(item.expired) ? item.expired : coerceTimestamp(decodeJwtPayload(item.access_token).exp);
      const credentials = {
        access_token: item.access_token,
        chatgpt_account_id: item.chatgpt_account_id,
        chatgpt_user_id: item.chatgpt_user_id,
        client_id: firstText(item.client_id, DEFAULT_CLIENT_ID),
        email: item.email,
        organization_id: item.organization_id,
        plan_type: firstText(item.plan_type, DEFAULT_PLAN_TYPE),
        refresh_token: item.refresh_token,
        session_token: item.session_token,
      };
      if (item.id_token) credentials.id_token = item.id_token;
      if (expiresAt) credentials.expires_at = expiresAt;
      for (const key of [
        "subscription_expires_at", "token_type", "scope", "openai_auth_mode", "auth_mode"
      ]) {
        if (item[key] !== "" && item[key] !== undefined) credentials[key] = item[key];
      }
      if (item.chatgpt_account_is_fedramp) credentials.chatgpt_account_is_fedramp = true;

      const account = {
        name: item.email,
        platform: "openai",
        type: "oauth",
        credentials,
        extra: {
          email: item.email,
          auth_provider: firstText(item.auth_provider, item.authProvider),
          source: firstText(item.source),
          openai_oauth_responses_websockets_v2_enabled: Boolean(item.openai_oauth_responses_websockets_v2_enabled),
          openai_oauth_responses_websockets_v2_mode: firstText(item.openai_oauth_responses_websockets_v2_mode, "off"),
          privacy_mode: firstText(item.privacy_mode, DEFAULT_PRIVACY_MODE),
        },
        concurrency: 10,
        priority: 1,
        rate_multiplier: 1,
        auto_pause_on_expired: true,
      };
      return account;
    }

    function buildAgentIdentityPayload(record, registration = {}) {
      const item = finalizeRecord(record);
      const runtimeId = firstText(registration.agent_runtime_id, item.agent_runtime_id);
      const privateKey = firstText(registration.agent_private_key, item.agent_private_key);
      if (!runtimeId || !privateKey || !item.chatgpt_account_id || !item.chatgpt_user_id) {
        throw new Error("Agent Identity auth.json 缺少 runtime、私钥、account_id 或 chatgpt_user_id");
      }
      const identity = {
        agent_runtime_id: runtimeId,
        agent_private_key: privateKey,
        account_id: item.chatgpt_account_id,
        chatgpt_user_id: item.chatgpt_user_id,
        email: item.email,
        plan_type: firstText(item.plan_type, DEFAULT_PLAN_TYPE),
        chatgpt_account_is_fedramp: Boolean(item.chatgpt_account_is_fedramp),
      };
      const taskId = firstText(registration.task_id, item.task_id);
      if (taskId) identity.task_id = taskId;
      return { auth_mode: "agent_identity", agent_identity: identity };
    }

    function buildCockpitPayload(record, now = new Date()) {
      const item = finalizeRecord(record);
      const expiresAt = item.refresh_token ? "" : firstText(item.expired) ? item.expired : coerceTimestamp(decodeJwtPayload(item.access_token).exp);
      return {
        type: "codex",
        id_token: item.id_token,
        access_token: item.access_token,
        refresh_token: item.refresh_token || "",
        account_id: item.chatgpt_account_id,
        last_refresh: now.toISOString(),
        email: item.email,
        expired: expiresAt ? new Date(expiresAt * 1000).toISOString() : "",
      };
    }

    function build9RouterPayload(record, now = new Date()) {
      const item = finalizeRecord(record);
      const expiresAt = item.refresh_token ? 0 : firstText(item.expired) ? item.expired : coerceTimestamp(decodeJwtPayload(item.access_token).exp);
      const nowIso = now.toISOString();
      const payload = {
        accessToken: item.access_token,
        refreshToken: item.refresh_token || undefined,
        expiresAt: expiresAt ? new Date(expiresAt * 1000).toISOString() : undefined,
        testStatus: firstText(item.status, "active"),
        expiresIn: expiresAt ? Math.max(0, expiresAt - Math.trunc(now.getTime() / 1000)) : undefined,
        providerSpecificData: {
          chatgptAccountId: item.chatgpt_account_id || undefined,
          chatgptPlanType: item.plan_type || undefined,
        },
        id: item.chatgpt_account_id || undefined,
        provider: "codex",
        authType: "oauth",
        name: item.email,
        email: item.email,
        priority: 9,
        isActive: !item.disabled,
        createdAt: item.created_at ? new Date(item.created_at * 1000).toISOString() : nowIso,
        updatedAt: item.last_used ? new Date(item.last_used * 1000).toISOString() : nowIso,
      };
      if (!payload.providerSpecificData.chatgptAccountId && !payload.providerSpecificData.chatgptPlanType) delete payload.providerSpecificData;
      return payload;
    }

    function buildCodexPayload(record, now = new Date()) {
      const item = finalizeRecord(record);
      return {
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: {
          id_token: item.id_token,
          access_token: item.access_token,
          refresh_token: item.refresh_token || "",
          account_id: item.chatgpt_account_id,
        },
        last_refresh: now.toISOString(),
      };
    }

    function buildAxonHubPayload(record, now = new Date()) {
      const item = finalizeRecord(record);
      const missingRefresh = !item.refresh_token;
      return {
        auth_mode: "chatgpt",
        last_refresh: now.toISOString(),
        tokens: {
          access_token: item.access_token,
          refresh_token: item.refresh_token || "",
          id_token: item.id_token,
        },
        ...(missingRefresh ? {
          axonhub_refresh_token_missing: true,
          axonhub_note: "refresh_token is missing; access_token works only until it expires.",
        } : {}),
      };
    }

    function buildCodexManagerPayload(record) {
      const item = finalizeRecord(record);
      return {
        tokens: {
          access_token: item.access_token,
          refresh_token: item.refresh_token || "",
          id_token: item.id_token || "",
          account_id: item.chatgpt_account_id || undefined,
          chatgpt_account_id: item.chatgpt_account_id || undefined,
        },
        meta: {
          label: item.email,
          workspace_id: item.workspace_id || undefined,
          chatgpt_account_id: item.chatgpt_account_id || undefined,
          note: "Imported from ChatGPT session",
        },
      };
    }

    function u16(value) {
      return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff);
    }

    function u32(value) {
      return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
    }

    function concatBytes(...parts) {
      const output = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
      let offset = 0;
      for (const part of parts) {
        output.set(part, offset);
        offset += part.length;
      }
      return output;
    }

    const crcTable = (() => {
      const table = new Uint32Array(256);
      for (let index = 0; index < 256; index += 1) {
        let value = index;
        for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        table[index] = value >>> 0;
      }
      return table;
    })();

    function crc32(bytes) {
      let crc = 0xffffffff;
      for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
      return (crc ^ 0xffffffff) >>> 0;
    }

    function createZipArchive(files) {
      const localParts = [];
      const centralParts = [];
      let offset = 0;

      for (const file of files) {
        const nameBytes = encoder.encode(sanitizeFilename(file.name, "account.json"));
        const dataBytes = encoder.encode(String(file.text ?? ""));
        const crc = crc32(dataBytes);
        const local = concatBytes(
          u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
          u32(crc), u32(dataBytes.length), u32(dataBytes.length), u16(nameBytes.length), u16(0),
          nameBytes, dataBytes
        );
        localParts.push(local);
        centralParts.push(concatBytes(
          u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
          u32(crc), u32(dataBytes.length), u32(dataBytes.length), u16(nameBytes.length),
          u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBytes
        ));
        offset += local.length;
      }

      const centralSize = centralParts.reduce((size, part) => size + part.length, 0);
      const end = concatBytes(
        u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
        u32(centralSize), u32(offset), u16(0)
      );
      return concatBytes(...localParts, ...centralParts, end);
    }

    const OAUTH_OUTPUT_MODES = Object.freeze([
      "to-cpa", "to-cockpit", "to-9router", "to-codex", "to-axonhub", "to-codex-manager"
    ]);

    function validateAgentIdentityCandidate(record, now = new Date()) {
      const item = finalizeRecord(record);
      if (item.credential_kind === "agent_identity") {
        if (!item.agent_runtime_id || !item.agent_private_key || !item.chatgpt_account_id || !item.chatgpt_user_id) {
          return { ok: false, reason: "现有 Agent Identity 缺少必要字段" };
        }
        return { ok: true, online: false, reason: "可直接导出已有 Agent Identity" };
      }
      if (!item.access_token || String(item.access_token).split(".").length !== 3) {
        return { ok: false, reason: "Agent Identity 注册需要有效的三段式 access_token JWT" };
      }
      const payload = decodeJwtPayload(item.access_token);
      const auth = extractAuth(payload);
      const accountId = firstText(item.chatgpt_account_id, extractAccountIdFromAuth(auth));
      const userId = firstText(item.chatgpt_user_id, auth.chatgpt_user_id, auth.user_id);
      if (!accountId || !userId) return { ok: false, reason: "JWT 缺少 chatgpt_account_id 或 chatgpt_user_id" };
      const exp = coerceTimestamp(payload.exp);
      if (exp && exp <= Math.trunc(now.getTime() / 1000)) return { ok: false, reason: "access_token JWT 已过期" };
      return { ok: true, online: true, reason: "需在线注册 Runtime；私钥仅在浏览器本地生成" };
    }

    function supportedModes(records, now = new Date()) {
      const items = records.map(finalizeRecord);
      if (!items.length) return { modes: [], details: {} };
      const details = {};
      const modes = ["normalize"];
      details.normalize = {
        level: items.some((item) => item.credential_kind === "agent_identity") ? "sensitive" : "complete",
        note: items.some((item) => item.credential_kind === "agent_identity") ? "标准化结果包含 Agent Identity 私钥，请妥善保存" : "仅重排已存在字段"
      };

      const subReady = items.every((item) => item.credential_kind === "agent_identity"
        ? Boolean(item.agent_runtime_id && item.agent_private_key && item.chatgpt_account_id && item.chatgpt_user_id)
        : Boolean(item.access_token));
      if (subReady) {
        modes.unshift("to-sub");
        details["to-sub"] = {
          level: items.some((item) => item.credential_kind === "agent_identity") ? "sensitive" : "complete",
          note: items.some((item) => item.credential_kind === "agent_identity")
            ? "Agent Identity 私钥会按 sub2api 原生字段写入，请妥善保存"
            : "OAuth 字段会按 sub2api 原生结构写入"
        };
      }

      const allOAuth = items.every((item) => item.credential_kind === "oauth" && item.access_token);
      if (allOAuth) {
        const degraded = items.some((item) => !item.refresh_token || !item.id_token);
        for (const mode of OAUTH_OUTPUT_MODES) {
          modes.splice(Math.max(0, modes.length - 1), 0, mode);
          details[mode] = {
            level: degraded ? "degraded" : "complete",
            note: degraded ? "可生成，但部分账号缺 refresh_token 或真实 id_token，长期刷新能力受限" : "完整 OAuth 字段可用"
          };
        }
      }

      const identityChecks = items.map((item) => validateAgentIdentityCandidate(item, now));
      if (identityChecks.every((check) => check.ok)) {
        const index = Math.max(0, modes.length - 1);
        modes.splice(index, 0, "to-agent-identity");
        details["to-agent-identity"] = {
          level: identityChecks.some((check) => check.online) ? "online" : "sensitive",
          note: identityChecks.some((check) => check.online)
            ? "需要显式在线注册；私钥在浏览器生成，access_token 仅用于注册 Runtime"
            : "可直接还原已有 Agent Identity auth.json"
        };
      }
      return { modes, details };
    }

    function buildAgentIdentityOutput(records, registrations = [], now = new Date()) {
      if (!records.length) throw new Error("当前输入里没有解析出有效记录。");
      const payloads = records.map((record, index) => buildAgentIdentityPayload(record, registrations[index] || {}));
      const payload = payloads.length === 1 ? payloads[0] : payloads;
      const text = JSON.stringify(payload, null, 2);
      return {
        text,
        parts: [text],
        name: payloads.length === 1 ? "auth.json" : exportFileName(payloads.length, "json", now),
        mime: "application/json;charset=utf-8",
        summary: payloads.length === 1 ? "已生成 Agent Identity auth.json；文件含私钥，请勿泄露。" : `已生成 ${payloads.length} 个 Agent Identity auth.json 记录；结果含私钥，请勿泄露。`,
      };
    }

    function buildOutput(records, mode, now = new Date()) {
      if (!records.length) throw new Error("当前输入里没有解析出有效记录。");

      if (mode === "normalize") {
        const lines = records.map((record) => JSON.stringify(record));
        const text = `${lines.join("\n")}${lines.length ? "\n" : ""}`;
        return {
          text,
          parts: [text],
          name: exportFileName(records.length, "txt", now),
          mime: "application/json;charset=utf-8",
          summary: `已标准化 ${records.length} 条记录，输出 unified JSONL。`,
        };
      }

      if (mode === "to-agent-identity") {
        const onlineRequired = records.some((record) => finalizeRecord(record).credential_kind !== "agent_identity");
        if (onlineRequired) throw new Error("该目标需要点击“注册并生成”，不能在自动转换时发起网络请求。");
        return buildAgentIdentityOutput(records, [], now);
      }

      const missingAccessToken = records.filter((record) => finalizeRecord(record).credential_kind === "oauth" && !firstText(record.access_token));
      if (missingAccessToken.length) {
        const labels = missingAccessToken.slice(0, 3).map((record) => firstText(record.email, record.chatgpt_account_id, "未知账号"));
        throw new Error(`除标准化 JSONL 外，目标格式必须有 access_token；缺失 ${missingAccessToken.length} 条：${labels.join("、")}`);
      }

      if (mode === "to-cpa") {
        const payloads = records.map((record) => buildCpaPayload(record, now));
        if (payloads.length === 1) {
          const text = JSON.stringify(payloads[0], null, 2);
          return {
            text,
            parts: [text],
            name: `codex-${sanitizeFilename(payloads[0].email, "account")}.json`,
            mime: "application/json;charset=utf-8",
            summary: "已生成 1 个 CPA token JSON。",
          };
        }

        const files = payloads.map((payload, index) => ({
          name: `codex-${sanitizeFilename(payload.email, `account_${index + 1}`)}.json`,
          text: JSON.stringify(payload, null, 2),
        }));
        const zipBytes = createZipArchive(files);
        return {
          text: ["CPA ZIP 包内文件：", ...files.map((file) => `- ${file.name}`)].join("\n"),
          parts: [zipBytes],
          name: "cliproxyapi-auth-files.zip",
          mime: "application/zip",
          summary: `已生成 1 个 CPA ZIP，包含 ${files.length} 个单账号 JSON 文件。`,
        };
      }

      if (mode === "to-sub") {
        const bundle = {
          type: "sub2api-data",
          version: 1,
          exported_at: now.toISOString(),
          proxies: [],
          accounts: records.map((record) => buildSubAccount(record)),
        };
        const text = JSON.stringify(bundle, null, 2);
        return {
          text,
          parts: [text],
          name: exportFileName(bundle.accounts.length, "json", now),
          mime: "application/json;charset=utf-8",
          summary: `已生成 1 个 sub2api bundle JSON，包含 ${bundle.accounts.length} 个账号。`,
        };
      }

      const extraModes = {
        "to-cockpit": { label: "Cockpit JSON", build: buildCockpitPayload },
        "to-9router": { label: "9router OAuth JSON", build: build9RouterPayload },
        "to-codex": { label: "Codex auth.json", build: buildCodexPayload },
        "to-axonhub": { label: "AxonHub auth.json", build: buildAxonHubPayload },
        "to-codex-manager": { label: "Codex-Manager JSON", build: buildCodexManagerPayload },
      };
      const extraMode = extraModes[mode];
      if (extraMode) {
        const payloads = records.map((record) => extraMode.build(record, now));
        const payload = payloads.length === 1 ? payloads[0] : payloads;
        const text = JSON.stringify(payload, null, 2);
        return {
          text,
          parts: [text],
          name: exportFileName(payloads.length, "json", now),
          mime: "application/json;charset=utf-8",
          summary: `已生成 ${payloads.length} 个 ${extraMode.label}。`,
        };
      }

      throw new Error(`不支持的输出模式：${mode}`);
    }

    function convertText(text, mode, now = new Date()) {
      const parsed = normalizeRecordsFromText(text);
      if (!parsed.records.length && parsed.skipped.length) {
        throw new Error(`没有可用于 OpenAI/ChatGPT 通道的记录：${parsed.skipped[0].reason}`);
      }
      const output = buildOutput(parsed.records, mode, now);
      if (parsed.skipped.length) output.summary += `；另跳过 ${parsed.skipped.length} 条：${parsed.skipped[0].reason}`;
      return { ...parsed, output };
    }


  const modes = Object.freeze([
    "normalize",
    "to-cpa",
    "to-sub",
    "to-cockpit",
    "to-9router",
    "to-codex",
    "to-axonhub",
    "to-codex-manager",
    "to-agent-identity"
  ]);

  globalThis.CVT_OPENAI = Object.freeze({
    modes,
    parse: normalizeRecordsFromText,
    convert: convertText,
    buildOutput,
    supportedModes,
    validateAgentIdentityCandidate,
    buildAgentIdentityPayload,
    buildAgentIdentityOutput,
    decodeJwtPayload
  });
})();
