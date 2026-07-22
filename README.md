# cvt

CPA、sub2api、OpenAI / ChatGPT 工具链账号凭证格式转换工具。页面部署在 Cloudflare Workers Assets 上；普通格式解析和生成全部在浏览器本地完成，只有用户明确点击生成 Agent Identity 时才调用固定目标注册接口。

当前转换规则按以下源码基线同步：

- CLIProxyAPI `v7.2.94` / `36b45d5`（Watchtower 于 2026-07-22 自动更新）
- sub2api `v0.1.162` / `27f094e0`（2026-07-22）

在线地址：

```text
https://cvt.caoo.kdns.fr
```

配套运行地址：

- CLIProxyAPI：`https://cpa.caoo.kdns.fr`
- sub2api：`https://sub.caoo.kdns.fr`（旧域名暂时保留用于平滑迁移）

CLIProxyAPI 与 sub2api 均部署在 US-SRV2；两个应用都由标签限定的 Watchtower 定时检查并自动更新。sub2api 使用 `weishaw/sub2api:latest`，当前运行版本仍为上面的 `v0.1.162` 基线。

CLIProxyAPI `v7.2.49 → v7.2.94` 的凭证结构复核结果：Codex、Claude、Antigravity、XAI 的持久化 token 结构未变；Codex 原生文件名现在只要存在 account ID 就加入其 SHA-256 前 8 位（不再只针对 team 方案），本项目已按该规则生成文件名。XAI 登录实现有调整，但持久化 token 字段未改变。

站点只有一个统一转换页：输入后自动识别格式与供应商，并只列出当前数据可以安全生成的输出格式。`/session/` 仅作为旧地址跳转到主页。

## 格式兼容边界

| 格式域 | 可转换范围 | 不能恢复的内容 |
| --- | --- | --- |
| 多供应商 CPA ↔ sub2api | Codex/OpenAI、Claude/Anthropic、Antigravity、XAI/Grok 双向；旧 CPA Gemini 仅可单向迁移到 sub2api | 代理配置、非 OAuth 账号；最新版 CPA 不再支持 Gemini auth |
| OpenAI / ChatGPT OAuth | Web Session、CPA Codex、sub2api OpenAI OAuth、Codex、9router、Cockpit、AxonHub、Codex-Manager、Unified JSONL | 缺失的 refresh_token、真实 id_token 和代理配置 |
| Agent Identity | 有效 ChatGPT access token 可显式在线注册；已有 Agent Identity 可在 `auth.json` 与 sub2api 原生字段间转换 | Agent Identity 不能还原或伪装成 CPA/OpenAI OAuth token |

OpenAI 通道先规范化为同一份凭证记录，再按当前记录能力生成目标格式。原始 `id_token` 只会原样保留，不会修改 JWT payload 后复用旧签名，也不会生成伪签名 token。缺少 `refresh_token` 或真实 `id_token` 时仍可生成兼容输出，但界面会明确标注长期刷新受限。

仓库地址：

```text
https://github.com/kongji1/cvt
```

## 功能

- `CLIProxyAPI auth JSON -> sub2api DataPayload`
- `sub2api DataPayload -> CLIProxyAPI auth JSON`
- 自动识别 CPA、sub2api、ChatGPT Web Session、Codex、9router、Cockpit、AxonHub、Codex-Manager 和 Unified JSONL
- CPA Codex / sub2api OpenAI 可继续输出上述全部 OpenAI 工具链格式
- 支持有效 ChatGPT Session / access token 生成 Agent Identity `auth.json`
- Ed25519 密钥对由浏览器 WebCrypto 本地生成，PKCS#8 私钥不会发送到 Worker 或 OpenAI
- 已有 Agent Identity 可直接转换为 sub2api 原生 `agentIdentity` credentials，也可还原为 `auth.json`
- 支持粘贴单个 JSON、数组、NDJSON、连续多个 JSON 对象
- 支持选择多个 `.json` 文件
- CPA 转 sub2api 可下载汇总 JSON，也可下载按账号拆分的 ZIP
- sub2api 转 CPA 会下载 ZIP，每个账号一个 CLIProxyAPI 原生 auth JSON
- 支持 `codex <-> openai`、`claude <-> anthropic`、`antigravity <-> antigravity`、`xai <-> grok`
- 兼容旧 CPA `gemini` / `gemini-cli` 文件向 sub2api 单向迁移
- Codex OAuth 反向导出使用最新版 CLIProxyAPI 原生文件名：有 ChatGPT account ID 时包含其 SHA-256 前 8 位及订阅档位
- sub2api Agent Identity 不会被错误显示为可转换 CPA；多供应商 bundle 只有全部账号都可逆时才显示 CPA 输出

## 转换规则

### CPA -> sub2api

输出文件是 sub2api 前端导入弹窗可读取的 `sub2api-data` v1 DataPayload：

```json
{
  "type": "sub2api-data",
  "version": 1,
  "exported_at": "2026-07-14T00:00:00.000Z",
  "proxies": [],
  "accounts": []
}
```

账号只转换凭证相关字段。`disabled=true` 的 CPA 账号会被跳过。

为了保持和 sub2api 默认 OAuth 新建账号一致，CPA 转出的普通账号会写入：

```json
{
  "concurrency": 10,
  "priority": 1,
  "rate_multiplier": 1,
  "auto_pause_on_expired": true
}
```

Grok OAuth 按最新 sub2api 新建表单使用 `concurrency: 1`，其余默认字段不变。

不会写入：

- `notes`
- `proxy_key`
- `group_ids`
- `load_factor`
- 账号级 `expires_at`

注意：token 的 `credentials.expires_at` 会保留；这里不写的是 sub2api 账号本身的过期时间。

这是一个公开使用的转换页面，因此两个方向都不会携带或还原代理配置。输入中的 `proxy_url`、`proxy_key`、代理用户名和密码会被主动丢弃。

### sub2api -> CPA

CPA 当前按“每账号一个 auth JSON”管理，不是一个 JSON 文件包含多个账号的导入格式。因此反向转换会生成 ZIP，解压后可得到多个 CPA auth JSON 文件。

CLIProxyAPI 最新源码已移除内置 Gemini auth 文件加载，`type: "gemini"` 会被直接忽略。因此反向转换遇到 sub2api Gemini 账号时会明确跳过，不生成无效的 CPA 文件；旧 CPA Gemini 文件仍可正向迁移到 sub2api。

支持从以下输入中读取账号：

- `sub2api-data` DataPayload
- `{ "data": { ... } }` 导入接口包装格式
- `accounts` 数组
- 单个 account 对象

带 `type` / `version` 的 DataPayload 会按 sub2api 当前规则校验：支持 `sub2api-data`、兼容 `sub2api-bundle`，版本为 `1`，并要求同时提供 `proxies` 和 `accounts` 数组。
最新版导出新增的可选 `skipped_shadows` 字段会被兼容读取。

## 本地开发

安装依赖：

```powershell
npm install
```

启动本地 Worker：

```powershell
npm run dev
```

运行转换回归测试：

```powershell
npm test
```

部署到 Cloudflare Workers：

```powershell
npm run deploy
```

当前 Worker 名称在 `wrangler.jsonc` 中配置为：

```json
{
  "name": "cvt"
}
```

## 项目结构

```text
.
├─ public/
│  ├─ index.html              # 统一自动识别转换页
│  ├─ openai-converter.js     # OpenAI / ChatGPT 共享转换引擎
│  ├─ agent-identity.js       # 浏览器本地密钥生成与显式注册流程
│  └─ session/
│     └─ index.html           # 旧地址跳转
├─ src/
│  └─ index.js                # 固定目标 Agent Runtime 注册 Worker
├─ ops/
│  └─ agent-register-proxy/   # US-SRV2 固定 OpenAI 注册目标代理（不含 secret）
├─ tests/
│  ├─ converter.test.mjs          # CPA / sub2api 回归测试
│  ├─ session-converter.test.mjs  # ChatGPT Session 回归测试
│  ├─ agent-identity.test.mjs     # 本地密钥与显式注册安全测试
│  ├─ worker.test.mjs             # Worker 输入/转发/脱敏测试
│  └─ ui-smoke.test.mjs           # 统一页面交互冒烟测试
├─ package.json       # Wrangler 命令
├─ wrangler.jsonc     # Cloudflare Workers Assets 配置
└─ README.md
```

## 安全说明

普通转换不会上传凭证。只有选择 Agent Identity 且明确点击“注册并生成”时，页面才会把当前 `access_token` 和 Ed25519 公钥发送到同源 `/api/agent-identity/register`；Worker 经带共享 secret 的专用 TLS 通道调用 US-SRV2 固定目标代理，再由代理转发到固定的 OpenAI Runtime 注册地址。Worker 和代理都不接受任意上游地址，也不记录或持久化请求体。

Ed25519 私钥只在浏览器内生成并以 PKCS#8 DER base64 写入下载结果，绝不会进入 Worker 请求。接口会校验同源、请求大小、JWT 结构/有效期/必要 claims 和 OpenSSH Ed25519 公钥结构，错误响应不会回显 token 或上游错误正文。

仍建议只在可信设备和可信浏览器环境中使用，并避免把生成文件提交到公开仓库或聊天窗口。
