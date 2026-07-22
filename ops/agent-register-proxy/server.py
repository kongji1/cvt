import base64
import hmac
import json
import os
import re
import struct
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


LISTEN_PORT = int(os.environ.get("PORT", "8080"))
PROXY_SECRET = os.environ.get("AGENT_REGISTER_PROXY_SECRET", "").strip()
REGISTER_PATH = "/.well-known/cvt-agent-register"
OPENAI_REGISTER_URL = "https://auth.openai.com/api/accounts/v1/agent/register"
MAX_BODY_BYTES = 16 * 1024
SSH_ALGORITHM = b"ssh-ed25519"
SAFE_CODE = re.compile(r"^[A-Za-z0-9_.:-]{1,80}$")
JWT_PATTERN = re.compile(r"^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$")


if not 32 <= len(PROXY_SECRET) <= 512:
    raise RuntimeError("AGENT_REGISTER_PROXY_SECRET must contain 32-512 characters")


def response_payload(handler, status, payload, extra_headers=None):
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    handler.close_connection = True
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json;charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("X-Content-Type-Options", "nosniff")
    handler.send_header("Connection", "close")
    handler.send_header("Content-Length", str(len(body)))
    if extra_headers:
        for name, value in extra_headers.items():
            handler.send_header(name, value)
    handler.end_headers()
    handler.wfile.write(body)


def error_payload(handler, status, code, extra_headers=None):
    response_payload(handler, status, {"error": {"code": code}}, extra_headers)


def safe_error_code(value, fallback="upstream_error"):
    code = str(value or "").strip()
    return code if SAFE_CODE.fullmatch(code) else fallback


def decode_jwt_payload(token):
    segment = token.split(".")[1]
    segment += "=" * (-len(segment) % 4)
    return json.loads(base64.urlsafe_b64decode(segment.encode("ascii")).decode("utf-8"))


def validate_jwt(token, now=None):
    if not 20 <= len(token) <= 12000 or not JWT_PATTERN.fullmatch(token):
        return "invalid_access_token"
    try:
        payload = decode_jwt_payload(token)
    except (ValueError, UnicodeError, json.JSONDecodeError):
        return "invalid_access_token_payload"
    if not isinstance(payload, dict):
        return "invalid_access_token_payload"
    current = int(time.time() if now is None else now)
    try:
        expires = float(payload.get("exp"))
    except (TypeError, ValueError):
        return "expired_access_token"
    if expires <= current:
        return "expired_access_token"
    try:
        not_before = float(payload.get("nbf")) if payload.get("nbf") is not None else None
    except (TypeError, ValueError):
        not_before = None
    if not_before is not None and not_before > current + 60:
        return "access_token_not_yet_valid"
    auth = payload.get("https://api.openai.com/auth")
    if not isinstance(auth, dict):
        return "missing_openai_auth_claims"
    account_id = str(auth.get("chatgpt_account_id") or auth.get("account_id") or "").strip()
    account_user_id = str(auth.get("chatgpt_account_user_id") or "")
    if not account_id and "__" in account_user_id:
        account_id = account_user_id.rsplit("__", 1)[-1].strip()
    user_id = str(auth.get("chatgpt_user_id") or auth.get("user_id") or "").strip()
    return None if account_id and user_id else "missing_agent_identity_claims"


def validate_public_key(value):
    if not isinstance(value, str):
        return False
    parts = value.strip().split()
    if len(parts) != 2 or parts[0] != "ssh-ed25519":
        return False
    try:
        blob = base64.b64decode(parts[1], validate=True)
        algorithm_length = struct.unpack(">I", blob[:4])[0]
        algorithm = blob[4:4 + algorithm_length]
        key_offset = 4 + algorithm_length
        key_length = struct.unpack(">I", blob[key_offset:key_offset + 4])[0]
    except (ValueError, struct.error):
        return False
    return (
        algorithm_length == len(SSH_ALGORITHM)
        and algorithm == SSH_ALGORITHM
        and key_length == 32
        and len(blob) == key_offset + 4 + key_length
    )


def validate_fixed_payload(payload):
    if not isinstance(payload, dict) or set(payload) != {"abom", "agent_public_key"}:
        return False
    abom = payload.get("abom")
    return isinstance(abom, dict) and abom == {
        "agent_version": "0.138.0-alpha.6",
        "agent_harness_id": "codex-cli",
        "running_location": "local",
    }


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


UPSTREAM = urllib.request.build_opener(NoRedirect())


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "cvt-agent-register-proxy"
    sys_version = ""

    def log_message(self, _format, *_args):
        return

    def do_GET(self):
        error_payload(self, 405, "method_not_allowed", {"Allow": "POST"})

    def do_HEAD(self):
        error_payload(self, 405, "method_not_allowed", {"Allow": "POST"})

    def do_POST(self):
        if self.path != REGISTER_PATH:
            error_payload(self, 404, "not_found")
            return
        supplied_secret = self.headers.get("X-CVT-Agent-Proxy-Secret", "")
        if not hmac.compare_digest(supplied_secret, PROXY_SECRET):
            error_payload(self, 403, "proxy_auth_required")
            return
        if not self.headers.get("Content-Type", "").lower().startswith("application/json"):
            error_payload(self, 415, "content_type_required")
            return
        try:
            content_length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            error_payload(self, 411, "content_length_required")
            return
        if content_length < 2 or content_length > MAX_BODY_BYTES:
            error_payload(self, 413 if content_length > MAX_BODY_BYTES else 400, "request_too_large" if content_length > MAX_BODY_BYTES else "invalid_json")
            return
        raw_body = self.rfile.read(content_length)
        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError):
            error_payload(self, 400, "invalid_json")
            return
        if not validate_fixed_payload(payload):
            error_payload(self, 400, "invalid_registration_payload")
            return
        authorization = self.headers.get("Authorization", "")
        if not authorization.startswith("Bearer "):
            error_payload(self, 401, "authorization_required")
            return
        access_token = authorization[7:].strip()
        jwt_error = validate_jwt(access_token)
        if jwt_error:
            error_payload(self, 400, jwt_error)
            return
        if not validate_public_key(payload.get("agent_public_key")):
            error_payload(self, 400, "invalid_agent_public_key")
            return

        upstream_request = urllib.request.Request(
            OPENAI_REGISTER_URL,
            data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
            method="POST",
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "cvt-agent-register-proxy/1.0",
            },
        )
        try:
            with UPSTREAM.open(upstream_request, timeout=20) as upstream:
                status = upstream.status
                upstream_body = upstream.read(MAX_BODY_BYTES + 1)
        except urllib.error.HTTPError as exc:
            status = exc.code if 400 <= exc.code <= 599 else 502
            upstream_body = exc.read(MAX_BODY_BYTES + 1)
        except (urllib.error.URLError, TimeoutError, OSError):
            error_payload(self, 502, "upstream_unreachable")
            return

        try:
            upstream_payload = json.loads(upstream_body.decode("utf-8")) if len(upstream_body) <= MAX_BODY_BYTES else {}
        except (UnicodeError, json.JSONDecodeError):
            upstream_payload = {}
        if not 200 <= status < 300:
            upstream_error = upstream_payload.get("error") if isinstance(upstream_payload, dict) else None
            code = upstream_error.get("code") if isinstance(upstream_error, dict) else None
            if not code and isinstance(upstream_payload, dict):
                code = upstream_payload.get("code")
            error_payload(self, status, safe_error_code(code))
            return
        runtime_id = str(upstream_payload.get("agent_runtime_id") or "").strip() if isinstance(upstream_payload, dict) else ""
        if not runtime_id or len(runtime_id) > 256:
            error_payload(self, 502, "invalid_upstream_response")
            return
        response_payload(self, 200, {"agent_runtime_id": runtime_id})


ThreadingHTTPServer(("0.0.0.0", LISTEN_PORT), Handler).serve_forever()
