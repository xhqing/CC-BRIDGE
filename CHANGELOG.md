# Changelog

本项目所有重要变更记录于此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [2.0.0] - 2026-07-24

重大重构：项目从「多上游模型代理（claude-proxy）」演化为「Claude Code 上游桥接框架（CC-BRIDGE）」。框架与上游适配器分层：通用逻辑在 `core/`，每个上游一个 `<name>-bridge/adapter.js`，先实现 GLM（z.ai GLM-5.2），预留 Kimi / Qwen。这是破坏性变更（breaking change），版本号升至 2.0.0。

### Added

- **CC-BRIDGE 框架 + adapter 架构**：新增 `core/`（server / adapter / config / daemon / claude / util）承载与上游无关的通用逻辑，上游专属逻辑（请求体适配、effort 映射、模型上限表）由各 `<name>-bridge/adapter.js` 实现统一接口（`name` / `displayName` / `defaultTarget` / `defaultSpoof` / `forceMaxEffort` / `modelMaxTokens` / `adaptRequestBody(obj, ctx)`）。新增上游只需加一个 adapter 文件 + 注册表（`core/adapter.js`）一行，框架、CLI、daemon 无需改动。
- **GLM adapter（glm-bridge/adapter.js）**：对接 z.ai GLM-5.2，移植原 z.ai 请求体适配（thinking 归一化、剥离 context_management / cache_control / Anthropic 专有 system 段、max_tokens 钳制、tools 尾部 cache_control）。
- **强制 GLM-5.2 始终 max 思考**：GLM adapter 设 `forceMaxEffort: true`，每条请求都强制 `reasoning_effort = max` + `output_config.effort = max` + `thinking.type = enabled`（三条保险），不受 Claude Code 的 `/effort` 档位影响。
- **多 API_KEY 容灾**：`API_KEY` 支持逗号分隔配置多个（推荐至少 2 个，共用同一 `API_BASE`）。某 KEY 返回 `401`/`403`（失效 / 欠费）时，桥熔断该 KEY 60 秒并立即切换下一个 KEY；瞬态错误（`429`/`5xx`/网络）先同 KEY 退避重试（`[200, 500]` ms）至多 2 次、用尽再换。所有 KEY 试遍才返回错误。URL 不变，只轮换 KEY。实现：`core/server.js` 的 `pickNextKey()` / `send()` + `KEY_BLOCK_SECONDS` 熔断表。
- **CLI `[upstream] <command>`**：`cc-bridge [upstream] <command>`，upstream 省略时默认 `glm`，可显式 `cc-bridge glm start` / `cc-bridge kimi start`（未实现上游会报错）。
- **按上游隔离的配置 / pid / 日志**：每个上游独立配置 `~/.cc-bridge/<upstream>.env`、pid 文件 `<upstream>.pid`、日志 `<upstream>.log`，多个上游可作为 daemon 并存（各用不同 `PROXY_PORT`）。
- **预留上游目录**：`kimi-bridge/`、`qwen-bridge/`（含 README 占位 + 扩展指南），`core/adapter.js` 注册表里 `implemented: false`。

### Changed

- **改名 cc-bridge**：CLI 命令、npm 包名、配置目录（`~/.cc-bridge/`）、环境变量（`$CC_BRIDGE_UPSTREAM` / `$CC_BRIDGE_CONFIG`）、日志前缀（`[bridge]`）全部由 `claude-proxy` 改为 `cc-bridge`。旧 `~/.claude-proxy/.env` 不再读取，需迁移到 `~/.cc-bridge/glm.env`。
- **目录结构调整**：`lib/` → `core/`（公共框架）；上游专属逻辑移入 `glm-bridge/`；新增 `kimi-bridge/`、`qwen-bridge/` 预留目录。
- **GitHub 仓库 rename**：`xhqing/claude-proxy` → `xhqing/CC-BRIDGE`。

### Removed

- `lib/openai-bridge.js`（OpenAI 格式互转层）与 `FORMAT` 配置项。
- 多 pair 路由（`API_BASE_2` / `SPOOF_MODEL_2` 数字后缀、`spoofToPair` / `targetToPair` 路由表）。
- SiliconFlow / MiMo 专用适配分支（已随多上游移除）。

### Migration（从 1.x 升级）

1. 卸载旧 `claude-proxy`，安装新版（`npm install -g cc-bridge-<版本>.tgz`）。
2. 迁移配置：把旧 `~/.claude-proxy/.env` 复制为 `~/.cc-bridge/glm.env`（或 `cc-bridge glm config --import <旧路径>`），把单条 `API_KEY` 改成逗号分隔的两条 z.ai KEY。
3. 删除所有 `_2` / `_3` 后缀的多 pair 配置和 `FORMAT` 行（不再支持）。
4. 命令由 `claude-proxy ...` 改为 `cc-bridge ...`（默认上游 glm，等价于 `cc-bridge glm ...`）。

## [1.1.1] - 2026-07-10

### Added

- **`claude-proxy --version` 命令**：支持 `version` / `-v` / `--version` 三种写法查询版本，从 `package.json` 读取版本号输出（如 `claude-proxy 1.1.1`），并补进 `help` 文本。便于在正式安装（非 `npm link`）环境下确认运行版本。

## [1.1.0] - 2026-07-10

针对「分类器间歇中断」故障（`claude-opus-4-8` 直连 `api.z.ai` 的链路抖动，被无 fallback 的单点路由放大为整体不可用）做可用性提升与可观测性改进。

### Added

- **同 pair 瞬态自动重试**：上游遇瞬态错误（`ENOTFOUND` / `ETIMEDOUT` / `ECONNRESET` / `EPIPE` / `socket hang up` / `timeout`，或 `429` / `5xx`）时，在同一 pair 上按 `UPSTREAM_RETRY_DELAYS = [200, 500]` 指数退避重试至多 2 次（共 3 次尝试），吸收毫秒级短抖动，降低分类器等短请求撞上断连窗口导致 `temporarily unavailable` 的概率。重试严格卡在「拿到首个上游响应之前」（尚未向客户端写响应头），一旦开始流式写回就不再切换，避免半截流。实现：`lib/server.js` 的 `isTransient()` / `handleUpstreamResponse()` / `attempt()`。非瞬态错误（`4xx` 业务错误）不重试，按原逻辑返回。注：跨 pair fallback（z.ai → SiliconFlow GLM-5.2）本次未实现，仍为后续治本项。
- **proxy.log 时间戳**：每行日志加 ISO 时间戳前缀（如 `[proxy 2026-07-10T02:08:14.123Z] POST /v1/messages ...`），便于把运行日志与实时故障逐请求对齐定位。

### Changed

- **dump 目录迁移**：`PROXY_DUMP=1` 写出的请求体 dump 从项目目录 `dumps/` 改为 `~/.claude-proxy/dumps/`（与 `proxy.log` / pid 同处），不再污染项目目录；路径由 `path.dirname(cfg.configPath)` 派生，兼容 `$CLAUDE_PROXY_CONFIG` 覆盖。同步更新 `README` / `README.zh-CN`，并在 `.gitignore` 增加 `dumps/`。

## [1.0.0] - 2026-07-07

首个正式版本。

### Added

- **透明 effort 解锁代理**：本地代理（默认 `127.0.0.1:8787`），通过给 Claude Code 喂白名单伪模型 ID（如 `claude-opus-4-8`），绕过客户端 effort 闸门，让第三方模型网关也能用 `/effort xhigh`。消息结构 / 工具调用 / SSE 事件 / `output_config.effort` 全部原样透传，只改写 `body.model`。
- **多上游 / 多模型对**：支持同时配置多对 `SPOOF_MODEL` ↔ `TARGET_MODEL`（数字后缀 `_2`、`_3`…），按 Claude Code 选择的伪 ID 路由到对应上游；**未知模型 HTTP 400 拒绝**，绝不静默改写到默认对。
- **双格式支持**：Anthropic 原生（`/v1/messages` 透传）与 OpenAI 兼容（`/v1/chat/completions`，由 `lib/openai-bridge.js` 做请求 / 响应 / 流式 SSE 格式互转，含 `reasoning_content` → `thinking` 块）。
- **请求体改写**（`rewriteBody`）：`thinking.type` 归一化为 `enabled`、按 effort 等级映射 `reasoning_effort`、剥离 `context_management` / `cache_control` / Anthropic 专有 system 段、`max_tokens` 钳到目标模型上限、tools 尾部打 `cache_control` 触发上游 context caching、SiliconFlow 强制 `thinking_budget` 上限、MiMo 强制 `reasoning_effort=high`。
- **modelUsage 注入**：把配置的 `contextWindow` / `maxOutputTokens` 注入响应的 `message_delta`（双 key：spoof + target），让 Claude Code webview 显示正确的上下文窗口。
- **后台 daemon 管理**：`claude-proxy daemon / stop / restart / status / logs`，detached 子进程 + pid 文件 + 日志文件。
- **用户级配置**：`~/.claude-proxy/.env`（gitignored，绝不打包进 npm 包），`claude-proxy config` 用 `$EDITOR` 编辑 / `--import` 从项目 `.env` 迁移 / `show` 脱敏打印 / `path` 打印路径。
- **一键启动**：`claude-proxy claude [args]` 启动代理 + 通过它启动 `claude` 并自动设好环境变量，退出自动清理代理。

### Fixed

- **流式 SSE 响应的 UTF-8 多字节字符处理**：原先对单个 chunk 做 `chunk.toString('utf-8')`，当中文（3 字节 / 字）被切在两个 chunk 边界时会解码失败产生 U+FFFD（??）乱码；改用 `TextDecoder('utf-8')` 的 stream 模式（`decoder.decode(chunk, { stream: true })`，`upRes.on('end')` 时 `decoder.decode()` flush 剩余字节），跨 chunk 字节自动接续，不再损坏。修复点：`lib/server.js` 流式 SSE 拦截段（注入 modelUsage 那条路径）+ `lib/openai-bridge.js` 的 `createStreamConverter.feed`。
