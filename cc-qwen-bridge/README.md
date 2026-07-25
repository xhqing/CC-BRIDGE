# CC-QWEN-BRIDGE（预留，待开发）

CC-BRIDGE 框架的 Qwen（通义千问 / 阿里云百炼）上游适配器。

状态：**预留目录，尚未实现**。当前在 `core/adapter.js` 注册表里 `implemented: false`，运行 `cc-bridge qwen …` 会提示未实现。

## 如何实现

1. 在本目录创建 `adapter.js`，实现统一 adapter 接口（参考 [`../cc-glm-bridge/adapter.js`](../cc-glm-bridge/adapter.js) 与 [`../core/adapter.js`](../core/adapter.js) 的接口注释）：
   - `name` / `displayName` / `defaultTarget` / `defaultSpoof`
   - `forceMaxEffort`（是否强制最高思考等级）
   - `modelMaxTokens`（Qwen 各模型的 max_tokens 表）
   - `adaptRequestBody(obj, ctx)`（把 Anthropic 请求体适配为 Qwen 友好的形式）
2. 在 [`../core/adapter.js`](../core/adapter.js) 的注册表里把 `qwen` 的 `implemented` 改为 `true`。
3. 核对配置字段（本目录已有预留模板 [`.env.example`](.env.example)，按实际可用模型 / 窗口填入）。

实现后即可用 `cc-bridge qwen start` / `cc-bridge qwen daemon` / `cc-bridge qwen config` 等命令，配置文件为 `~/.cc-bridge/qwen.env`。
