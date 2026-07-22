# cvt

CPA / sub2api 账号凭证格式转换工具。项目是一个纯静态 Web 页面，部署在 Cloudflare Workers Assets 上，所有解析和生成都在浏览器本地完成。

当前转换规则按以下源码基线同步：

- CLIProxyAPI `db82d65d`（2026-07-21）
- sub2api `5a8d6c4e`（2026-07-21）

在线地址：

```text
https://cvt.caoo.kdns.fr
```

同一站点按凭证语义分成两个浏览器本地转换通道，而不是把所有格式强行合并：

- `/`：多供应商 CPA / sub2api OAuth 转换
- `/session/`：仅 OpenAI / ChatGPT 凭证互转，可输出 CPA、sub2api、Codex、9router、Cockpit、AxonHub 和 Codex-Manager 格式

两个页面均不上传输入内容；ChatGPT Session 转换器由原 `json.caoo.kdns.fr` 项目整合而来，旧站暂时保留作为兼容入口。

## 格式兼容边界

| 格式域 | 可转换范围 | 不能恢复的内容 |
| --- | --- | --- |
| 多供应商 CPA ↔ sub2api | Codex/OpenAI、Claude/Anthropic、Antigravity、XAI/Grok 双向；旧 CPA Gemini 仅可单向迁移到 sub2api | 代理配置、非 OAuth 账号、Agent Identity 私钥；最新版 CPA 不再支持 Gemini auth |
| OpenAI / ChatGPT | Web Session、CPA Codex、sub2api OpenAI OAuth、Codex、9router、Cockpit、AxonHub、Codex-Manager、Unified JSONL | 缺失的 refresh_token、已签名 id_token、私钥和代理配置 |

OpenAI 通道先规范化为同一份凭证记录，再生成目标格式。原始 `id_token` 只会原样保留，不会修改 JWT payload 后复用旧签名，也不会生成伪签名 token。除标准化 JSONL 外，所有输出都要求输入含 `access_token`。

仓库地址：

```text
https://github.com/kongji1/cvt
```

## 功能

- `CLIProxyAPI auth JSON -> sub2api DataPayload`
- `sub2api DataPayload -> CLIProxyAPI auth JSON`
- 支持粘贴单个 JSON、数组、NDJSON、连续多个 JSON 对象
- 支持选择多个 `.json` 文件
- CPA 转 sub2api 可下载汇总 JSON，也可下载按账号拆分的 ZIP
- sub2api 转 CPA 会下载 ZIP，每个账号一个 CLIProxyAPI 原生 auth JSON
- 支持 `codex <-> openai`、`claude <-> anthropic`、`antigravity <-> antigravity`、`xai <-> grok`
- 兼容旧 CPA `gemini` / `gemini-cli` 文件向 sub2api 单向迁移
- Codex OAuth 反向导出使用最新版 CLIProxyAPI 原生文件名：有 ChatGPT account ID 时包含其 SHA-256 前 8 位及订阅档位
- sub2api Agent Identity 当前无法被 CLIProxyAPI 使用，反向转换会明确安全跳过且不会输出私钥

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
│  ├─ index.html              # CPA / sub2api 页面和全部前端逻辑
│  └─ session/
│     └─ index.html           # ChatGPT JSON / Session 页面和全部前端逻辑
├─ tests/
│  ├─ converter.test.mjs         # CPA / sub2api 回归测试
│  └─ session-converter.test.mjs # ChatGPT Session 回归测试
├─ package.json       # Wrangler 命令
├─ wrangler.jsonc     # Cloudflare Workers Assets 配置
└─ README.md
```

## 安全说明

页面不需要后端 API，不会上传账号凭证。输入的 access token、refresh token、id token 等敏感信息只在当前浏览器内解析和生成下载文件。

仍建议只在可信设备和可信浏览器环境中使用，并避免把生成文件提交到公开仓库或聊天窗口。
