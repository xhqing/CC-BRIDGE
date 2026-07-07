# Changelog

本项目所有重要变更记录于此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

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
