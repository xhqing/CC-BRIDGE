# CC-BRIDGE 项目指南

CC-BRIDGE 是 Claude Code 上游桥接框架（GLM / Kimi / Qwen …）。通用框架在 [`core/`](../core/)，每个上游一个 `<name>-bridge/adapter.js`，通过 `core/adapter.js` 注册表加载。当前已实现 `glm`（z.ai GLM-5.2），`kimi` / `qwen` 为预留。

## 架构要点

- **框架与上游分离**：`core/server.js` 是与上游无关的公共 HTTP 服务（model 改写、多 KEY 容灾、modelUsage 注入、daemon）；上游专属逻辑（请求体适配、effort 映射、模型上限表）在各 `<name>-bridge/adapter.js` 里实现统一接口，由 `adapter.adaptRequestBody(obj, ctx)` 调用。
- **新增上游**：建 `<name>-bridge/adapter.js`（参考 `glm-bridge/adapter.js`）+ 在 `core/adapter.js` 注册表把 `implemented` 改 `true`。框架、CLI、daemon 无需改动。
- **CLI**：`cc-bridge [upstream] <command>`，upstream 省略时默认 `glm`。
- **配置**：每上游一个 `~/.cc-bridge/<upstream>.env`，pid / 日志也按上游区分（`<upstream>.pid` / `<upstream>.log`），多上游可并存（各用不同 `PROXY_PORT`）。

## 项目规则

- @rules/cc-bridge-install.md  cc-bridge 运行版本必须从 GitHub Release 的 tgz 全局安装，禁止用 `npm link` 把开发目录链接为全局命令。
