# CC-DS-BRIDGE — Claude Code ↔ DeepSeek-V4 适配器

CC-BRIDGE 框架的 DeepSeek 上游适配器，对接 [DeepSeek](https://api-docs.deepseek.com) 的 DeepSeek-V4 系列（`deepseek-v4-pro` / `deepseek-v4-flash`）。为绕开 DeepSeek Anthropic 兼容端点（`/anthropic`）不支持并发 `tool_use` 的限制，adapter 内部通过 OpenAI 兼容端点（`/chat/completions`）调用 DeepSeek，Anthropic ↔ OpenAI 格式转换自动完成，对 Claude Code 完全透明。

## 它做什么

- 把 Claude Code 发来的 Anthropic `/v1/messages` 请求体适配为 DeepSeek 友好的形式（见下表）。
- 按 `MODEL_MAP` 把 `body.model` 从 spoof（如 `claude-opus-4-8` / `claude-haiku-4-5`）改写回 `deepseek-v4-pro` / `deepseek-v4-flash`。
- **按 target 模型钉死思考等级**（`MODEL_THINKING`，取值 `max` / `high` / `none`，分别对应 DeepSeek-V4 的 Think Max / Think High / 不思考）——每个模型各自配置，忽略 Claude Code 传来的 effort 档位。

## 支持的模型

| 模型 ID | 上下文窗口 | 钳制 max_tokens | 说明 |
|---------|-----------|----------------|------|
| `deepseek-v4-pro` | 1M | 128K | 主力模型，思考默认开启（Think Max） |
| `deepseek-v4-flash` | 1M | 128K | 轻量快速模型 |

> DeepSeek-V4 上下文窗口 1M、单次输出能力充裕（官方未公布精确输出上限，第三方实测 flash 可达 384K）。上表「钳制 max_tokens」是 adapter 为避免偶发超大 `max_tokens` 触发上游拒收而设的保守保护值，不限制正常输出；需要更大输出可改 `cc-ds-bridge/adapter.js` 的 `MODEL_MAX_TOKENS`。
>
> 旧模型名 `deepseek-chat` / `deepseek-reasoner` 已于 2026/07/24 弃用（分别对应 `deepseek-v4-flash` 的非思考 / 思考模式），本适配器只使用 V4 新名。

## 请求体适配项

| 适配项 | 原因 |
|--------|------|
| 按 target 模型钉死 `thinking.type`（`enabled`/`disabled`）、`reasoning_effort`、`output_config.effort` | 由 `MODEL_THINKING` 配置每个模型的思考等级（`max`/`high`/`none`，对应 Think Max / Think High / 不思考），忽略客户端 `/effort` 档位 |
| 剥离 `context_management` | Claude Code 专有，DeepSeek 不识别 |
| 清空 `metadata.user_id` | DeepSeek 虽支持 `user_id` 做限流隔离，但 CC 传的是设备指纹 / session_id，对单用户限流无意义且泄露隐私 |
| 递归剥离 `cache_control` | DeepSeek 官方兼容表标记为 Ignored，缓存是隐式自动的 |
| 把 `max_tokens` 钳到目标模型上限 | 避免偶发超大请求被拒 |
| 剥离 Anthropic 专有 `system` 段（`x-anthropic-billing-header:`、Agent SDK 声明） | 对 DeepSeek 无意义 |

> 与 GLM / MiMo 适配器不同，本适配器**不在 `tools` 尾部打 `cache_control`**：DeepSeek 官方明确 `cache_control` 被忽略，其 Context Caching 是隐式自动的（按 prompt 前缀匹配），打标无意义；缓存命中情况由框架从上游响应的 `usage` 旁路观测。

## 配置

配置文件：`~/.cc-bridge/ds.env`（模板见本目录 [`ds.env.example`](ds.env.example)）。

主要字段：`API_BASE`（DeepSeek API 基地址，只填 `https://api.deepseek.com` 即可，adapter 自动走 OpenAI 端点）、`API_KEY`（逗号分隔多个 DeepSeek KEY，支持容灾）、`MODEL_MAP`（`spoof->target` 映射对，支持多对，默认 `claude-opus-4-8->deepseek-v4-pro`）、`MODEL_THINKING`（按 target 模型配思考等级 `max`/`high`/`none`，默认全 `max`）。

## adapter 接口

本目录的 `adapter.js` 导出统一 adapter 接口：`name` / `displayName` / `defaultTarget` / `defaultSpoof` / `defaultThinking` / `modelMaxTokens` / `adaptRequestBody(obj, ctx)` / `makeUpstreamCall(ctx)`。其中 `makeUpstreamCall` 是 ds adapter 的特殊方法——接管上游请求，把 Anthropic 格式转为 OpenAI 格式调 DeepSeek 的 `/chat/completions`，再把响应转回 Anthropic 格式。框架层（[core/](../core/)）检测到该方法时自动把请求控制权交给 adapter；不实现该方法的上游走原有 Anthropic 透传路径，详见 [core/server.js](../core/server.js)。
