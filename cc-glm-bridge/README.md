# CC-GLM-BRIDGE — Claude Code ↔ GLM-5.2 (z.ai) 适配器

CC-BRIDGE 框架的 GLM 上游适配器，对接 [z.ai](https://z.ai) 的 GLM-5.2（Coding Plan）。这是目前唯一已实现的上游适配器。

## 它做什么

- 把 Claude Code 发来的 Anthropic `/v1/messages` 请求体适配为 z.ai GLM-5.2 友好的形式（见下表）。
- 按 `MODEL_MAP` 把 `body.model` 从 spoof（如 `claude-opus-4-8` / `claude-haiku-4-5`）改写回 `glm-5.2`。
- **按 target 模型钉死思考等级**（`MODEL_THINKING`，取值 `max` / `high` / `none`）——每个模型各自配置，忽略 Claude Code 传来的 effort 档位。

## 请求体适配项

| 适配项 | 原因 |
|--------|------|
| 按 target 模型钉死 `thinking.type`（`enabled`/`disabled`）、`reasoning_effort`、`output_config.effort` | 由 `MODEL_THINKING` 配置每个模型的思考等级（`max`/`high`/`none`），忽略客户端 `/effort` 档位 |
| 剥离 `context_management` | Claude Code 专有，z.ai 不识别 |
| 清空 `metadata.user_id` | 设备指纹 / session_id 发给上游无意义且泄露隐私 |
| 递归剥离 `cache_control` | z.ai 不认 Anthropic 的 cache 标记 |
| 把 `max_tokens` 钳到目标模型上限（GLM 系列表） | 避免过大请求被拒 |
| 剥离 Anthropic 专有 `system` 段（`x-anthropic-billing-header:`、Agent SDK 声明） | 对 z.ai 无意义 |
| 给 `tools` 尾部打 `cache_control` | 触发 z.ai context caching |

## 配置

配置文件：`~/.cc-bridge/glm.env`（模板见本目录 [`glm.env.example`](glm.env.example)）。

主要字段：`API_BASE`（z.ai 接口地址）、`API_KEY`（逗号分隔多个 z.ai KEY，支持容灾）、`MODEL_MAP`（`spoof->target` 映射对，支持多对，默认 `claude-opus-4-8->glm-5.2`）、`MODEL_THINKING`（按 target 模型配思考等级 `max`/`high`/`none`，默认全 `max`）。

## adapter 接口

本目录的 `adapter.js` 导出统一 adapter 接口：`name` / `displayName` / `defaultTarget` / `defaultSpoof` / `defaultThinking` / `modelMaxTokens` / `adaptRequestBody(obj, ctx)`。新增其它上游适配器时实现同一接口即可，框架层（[core/](../core/)）无需改动，详见 [core/adapter.js](../core/adapter.js)。
