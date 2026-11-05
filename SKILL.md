# SKILL.md

本项目开发期操作手册。运行时行为与界面见 `docs/`。

## providers 程序集（拉取并适配大模型接口）

`providers/` 是一个**独立的 Node 程序集**，用于从各 LLM provider 的 `/models` 接口拉取模型列表、落盘原始响应，并适配写入运行时配置 `user/providers.json`（不入 git）。

### 目录结构
- `providers/index.js` — runner（不依赖 `core`）。
- `providers/<name>.js` — 每个 provider 一个模块，导出 `{ name, baseUrl, apiKeyEnv?, reasoningParam?, fetch(), adapt(raw) }`。
  - `fetch()`：发 `GET {baseUrl}/models`，优先复用 `user/providers.json` 里已有的 `base_url`/`api_key`，否则回退默认 baseUrl / 环境变量；返回落盘结构 `{ provider, base_url, fetchedAt, status, body }`（失败也返回，`error:true`）。
  - `adapt(raw)`：从 `raw.body` 提取并映射为现有 schema：`{ models: [{ name, fee, effort?: { supported_levels, default_level } }] }`。
  - `reasoningParam`（可选）：声明该 provider 的推理参数风格，runner 合并时写入 `user/providers.json` 的 `reasoning_param`（见下）。取值 `"thinking"` / `"reasoning_effort"` / `"none"`。

### 运行方式（npm scripts）
```bash
npm run providers -- <name>   # 拉取并适配单个 provider（如 radeon / deepseek）
npm run providers              # 拉取并适配全部 provider
npm run providers:all          # 同上（语义别名）
```

### 数据流
1. `fetch()` → 写 `user/providers/<name>.json`（整份原始响应，含 HTTP 状态与报文，便于排查）。
2. `adapt()` 读取刚落盘的 raw → 产出模型数组。
3. runner 读现有 `user/providers.json`，定位同名 provider（无则新增），**整体替换其 `models`**，保留既有 `base_url` / `api_key` / `description` / `reasoning_param`（除非原本缺）。

### reasoning_param（推理参数风格）
`user/providers.json` 每个 provider 可带 `reasoning_param`，决定 effort 如何翻译为 provider 请求字段（由 `core/index.js` `_stream` 按 baseUrl 匹配读取）：
- `"thinking"`：off 发 `{"thinking":{"type":"disabled"}}`，其余等级发 `{"reasoning_effort":"<level>"}`（DeepSeek 等）。
- `"reasoning_effort"`：off 省略该字段（默认即关闭推理），其余等级发 `{"reasoning_effort":"<level>"}`（OpenAI 及多数兼容网关，含 radeon）。
- `"none"`：一律不注入推理参数。
- 缺省：`"reasoning_effort"`（最安全通用默认，不发送 thinking，避免 400）。

配置方式二选一：直接在 `user/providers.json` 写该字段，或在 `providers/<name>.js` 声明 `reasoningParam`，由 runner 写入。

### 新增一个 provider
1. 在 `providers/` 下新建 `<name>.js`，导出 `name` / `baseUrl` / `fetch` / `adapt`（可参照 `radeon.js` / `deepseek.js`）。
2. `adapt()` 只负责把厂商响应映射成现有 schema；厂商差异（effort、context_window 等）写在该模块内。
3. 运行 `npm run providers -- <name>` 验证落盘与写回。

### 注意事项
- 该程序集**独立于 `core`**：不改动 `core/index.js` 的 `fetchModels` RPC；前端「拉取远端模型」仍走原 RPC。
- 若 provider 的 `/models` 不返回 effort 元数据（radeon、deepseek 均如此），适配后 `effort` 字段留空，可在 UI「编辑模型」按厂商文档手动维护。
- `user/providers.json` 与 `user/providers/*.json` 均含密钥，不入 git（见 `.gitignore`）。
- 当前 `adapt()` 对 models 是整体替换；如需保留手写的 `effort`/`fee` 默认值，应在 `adapt()` 中做合并而非覆盖。
