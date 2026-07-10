# Changelog

本项目所有重要变更记录于此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

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
