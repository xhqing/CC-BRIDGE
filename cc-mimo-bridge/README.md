# CC-MIMO-BRIDGE — Claude Code ↔ MiMo (小米) 适配器

CC-BRIDGE 框架的 MiMo 上游适配器，对接小米 [MiMo](https://platform.xiaomimimo.com) 的 MiMo-V2.5-Pro 模型。

## 它做什么

- 把 Claude Code 发来的 Anthropic `/v1/messages` 请求体适配为 MiMo 友好的形式（见下表）。
- 按 `MODEL_MAP` 把 `body.model` 从 spoof（如 `claude-opus-4-8` / `claude-haiku-4-5`）改写回 `mimo-v2.5-pro`。
- **按 target 模型钉死思考开关**（`MODEL_THINKING`，取值 `enabled` / `disabled`）——MiMo 官方 API 只支持这两种状态，不支持中间等级（如 high/medium/low）。每个模型各自配置，忽略 Claude Code 传来的 effort 档位。

## 支持的模型

| 模型 ID | 上下文窗口 | 最大输出 | 能力 |
|---------|-----------|---------|------|
| mimo-v2.5-pro | 1M | 128K | 文本生成、深度思考、流式输出、函数调用、结构化输出、联网搜索 |
| mimo-v2.5 | 1M | 128K | 文本生成、全模态理解、深度思考、流式输出、函数调用、结构化输出、联网搜索 |

## 请求体适配项

| 适配项 | 原因 |
|--------|------|
| 按 target 模型钉死 `thinking.type`（`enabled`/`disabled`） | MiMo 官方 API 只支持这两种状态，由 `MODEL_THINKING` 配置每个模型的思考开关，忽略客户端 `/effort` 档位 |
| 剥离 `context_management` | Claude Code 专有，MiMo 不识别 |
| 清空 `metadata.user_id` | 设备指纹 / session_id 发给上游无意义且泄露隐私 |
| 递归剥离 `cache_control` | MiMo 不认 Anthropic 的 cache 标记 |
| 把 `max_tokens` 钳到目标模型上限（MiMo 系列表） | 避免过大请求被拒 |
| 剥离 Anthropic 专有 `system` 段（`x-anthropic-billing-header:`、Agent SDK 声明） | 对 MiMo 无意义 |
| 给 `tools` 尾部打 `cache_control` | 触发 MiMo context caching |

## 配置

配置文件：`~/.cc-bridge/mimo.env`（模板见本目录 [`mimo.env.example`](mimo.env.example)）。

主要字段：`API_BASE`（MiMo Anthropic 兼容接口地址）、`API_KEY`（逗号分隔多个 MiMo KEY，支持容灾）、`MODEL_MAP`（`spoof->target` 映射对，支持多对，默认 `claude-opus-4-8->mimo-v2.5-pro`）、`MODEL_THINKING`（按 target 模型配思考开关 `enabled`/`disabled`，默认全 `enabled`）。

## adapter 接口

本目录的 `adapter.js` 导出统一 adapter 接口：`name` / `displayName` / `defaultTarget` / `defaultSpoof` / `defaultThinking` / `modelMaxTokens` / `adaptRequestBody(obj, ctx)`。新增其它上游适配器时实现同一接口即可，框架层（[core/](../core/)）无需改动，详见 [core/adapter.js](../core/adapter.js)。
