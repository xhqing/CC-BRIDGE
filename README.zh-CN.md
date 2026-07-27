<div align="center">
  <img src="assets/logo.svg" alt="CC-BRIDGE" width="640">
</div>

# CC-BRIDGE —— Claude Code 上游桥接框架

> [English](README.md)

<div align="center">

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![GitHub stars](https://img.shields.io/github/stars/xhqing/CC-BRIDGE?style=social)
![GitHub last commit](https://img.shields.io/github/last-commit/xhqing/CC-BRIDGE)
![Built with Claude Code](https://img.shields.io/badge/Built%20with-Claude%20Code-19C37D)
![Type: Project](https://img.shields.io/badge/Type-Project-lightgrey)

</div>

一个本地透明桥接框架，让 **Claude Code 访问第三方模型上游**（GLM / Kimi / Qwen ……）。每个上游在独立的 `cc-<name>-bridge/` 目录下有一个 adapter 模块，共享同一套框架（`core/`）。作为白名单伪模型中转的附带效果，CC-BRIDGE 为非官方 provider **解锁 `/effort xhigh`**；同时支持**多 API_KEY 容灾**，并能**强制模型始终以 `max` 思考等级运行**。

> **当前已实现：** `glm`（z.ai GLM-5.2）。`kimi` / `qwen` 为预留占位——见[添加新上游](#添加新上游)。

安装一次后，在**任意目录**下用一条命令即可启动：`cc-bridge`。

## 可用上游

| 上游 | 状态 | adapter | 目标模型 |
|------|------|---------|----------|
| `glm` | ✅ 已实现 | [cc-glm-bridge/](cc-glm-bridge/) | z.ai 上的 GLM-5.2 |
| `kimi` | 🚧 预留 | [cc-kimi-bridge/](cc-kimi-bridge/) | — |
| `qwen` | 🚧 预留 | [cc-qwen-bridge/](cc-qwen-bridge/) | — |

## 它能做什么

- **框架 + 按上游分 adapter。** 所有与上游无关的通用逻辑（HTTP 服务、多 KEY 容灾、model 改写、modelUsage 注入、daemon）都在 [`core/`](core/)；每个上游的专属逻辑（请求体适配、effort 映射、模型上限表）在各自的 `cc-<name>-bridge/adapter.js`。新增上游只需加一个文件 + 注册表一行。
- **解锁 effort。** 通过白名单伪模型 ID 中转，绕过 Claude Code 客户端的 effort 闸门，让第三方上游也能用 `/effort xhigh`。（见[effort 闸门（xhigh 与 max）](#effort-闸门xhigh-与-max)。）
- **多 KEY 容灾。** 把多个 KEY 各自成行配成编号变量（`API_KEY_1=…`、`API_KEY_2=…`…，每行一个，方便单独注释账号来源、或整行注释掉禁用某 KEY；旧式逗号分隔 `API_KEY=k1,k2` 仍兼容）。某 KEY 返回 `401`/`403`（被拒 / 额度用尽）时，桥把它熔断 60 秒并立即切换下一个 KEY；瞬态错误（`429`/`5xx`/网络）先在同 KEY 重试、用尽再换。URL 始终不变，只轮换 KEY。（见[多 KEY 容灾](#多-key-容灾)。）
- **始终 max 思考（GLM）。** GLM adapter 在每条请求上强制 `reasoning_effort = max`，不受客户端 `/effort` 档位影响。
- **按上游隔离。** 每个上游有独立配置（`~/.cc-bridge/<upstream>.env`）、pid 文件、日志文件，多个上游可作为 daemon 并存（用不同 `PROXY_PORT`）。
- **零运行时依赖。** 仅用 Node ≥ 14 内置模块。

## 工作原理

```
                              ┌── KEY #1 ──┐
Claude Code ──POST /v1/messages──▶  cc-bridge (127.0.0.1:8787)
  model = <伪模型 ID>               · 改写 body.model → 真实模型      ├── KEY #2 ──┤  上游 · 目标模型
                                    · adapter.adaptRequestBody(body)  │  (容灾切换) │
                                    · 遇 401/403 → 切换下一个 KEY    └────────────┘
                                    · 向响应注入 modelUsage
```

上游由 `<upstream>` 参数选定（默认 `glm`）。桥加载 `core/adapter.js` → 对应上游的 `adapter.js`，对每条转发的请求应用该 adapter 的 `adaptRequestBody`。

## effort 闸门（xhigh 与 max）

> ⚠️ **一律使用 `/effort xhigh`，绝不使用 `/effort max`。** 当前版本的 VS Code 插件里 `max` **完全不可用**——它不在插件的 `effortLevel` 枚举里，会被静默强制回 `high`，模型实际不会以 `max` 运行。要让思考等级稳定保持在最高档，请在 **CLI 和 VS Code 插件** 两边统一使用 `/effort xhigh`。`xhigh` 是 VS Code 插件支持的最高档位，CLI 和插件都接受。

Claude Code 把 `max`/`xhigh` 两档 effort 卡在**客户端**检查上：当前模型 ID 必须在 Claude 白名单里，**或者** provider 必须是官方 / Bedrock / Foundry。第三方网关两条都不满足，于是 `/effort max` 静默回落到 `high`。通过本桥用白名单伪模型 ID 中转就能通过检查；桥随后在请求发往上游之前把 `body.model` 改写回真实模型。

## 前置条件

- **Node.js ≥ 14** 和 **npm**，在 PATH 中可用。
  - Homebrew 用户：如果 `which node` 没输出，说明 keg 没链接。运行 `brew link --overwrite node@22`，并确保 `/opt/homebrew/bin` 在 PATH 中。

## 安装

CC-BRIDGE 以构建好的 tarball 发布在 GitHub Release（仓库为私有，需用带认证的 `gh` 下载）：

```bash
gh release download v2.0.0 --pattern 'cc-bridge-2.0.0.tgz' --dir /tmp --clobber
npm install -g /tmp/cc-bridge-2.0.0.tgz
```

> 权限不足？用 `sudo npm install -g …`，或者一次性设一个用户可写的前缀（`npm config set prefix ~/.local`，确保 `~/.local/bin` 在 PATH 中）后再不带 sudo 运行。

安装后，`cc-bridge` 就在 PATH 中，任意目录可用。

## 配置

每个上游的配置位于 `~/.cc-bridge/<upstream>.env`（用户级，任意工作目录都能找到）。GLM：

```bash
cc-bridge glm config        # 用 $EDITOR 打开 ~/.cc-bridge/glm.env（首次运行从模板生成）
cc-bridge glm config show   # 打印当前值（API_KEY 脱敏）
cc-bridge glm config path   # 打印配置文件路径
cc-bridge glm config --import /path/to/.env   # 迁移已有 .env
```

```ini
# ~/.cc-bridge/glm.env  — GLM（z.ai GLM-5.2）
API_BASE=https://api.z.ai/api/anthropic
# 每个 KEY 单独一行——可在上方注释账号来源，整行注释掉即禁用该 KEY。
# 旧式逗号分隔 API_KEY=k1,k2 仍兼容。
# 账号 A
API_KEY_1=your_zai_key_1
# 账号 B
API_KEY_2=your_zai_key_2
# MODEL_MAP：spoof->target 映射对（逗号分隔）。opus 是 Claude Code 主力模型、haiku 是
# 轻量模型——两对都指向 glm-5.2。第一对是「主力对」（启动 claude 时的默认模型）。
# 旧式单对 SPOOF_MODEL / TARGET_MODEL 仍向后兼容。
MODEL_MAP=claude-opus-4-8->glm-5.2,claude-haiku-4-5->glm-5.2
PROXY_PORT=8787
PROXY_LOG=1                             # 0 关闭每请求日志
```

> **路由：** `MODEL_MAP` 把一个或多个 spoof ID 映射到真实模型（`spoof->target` 对）。传入的 `model` 命中某对 spoof 时改写为该对的 target；已是某对 target 时原样透传。其余一律**被 HTTP 400 拒绝**，绝不静默改写。旧式单对 `SPOOF_MODEL` / `TARGET_MODEL` 仍向后兼容（等价于一对）。

## 用法

```bash
cc-bridge start           # 默认上游（glm），后台（detached）
cc-bridge daemon          # start 的别名（后台）
cc-bridge claude [args]   # 启动桥接 + 启动指向它的 claude
cc-bridge stop            # 停止后台服务
cc-bridge restart         # 重启后台服务（stop + start）
cc-bridge status          # 查看运行状态
cc-bridge logs            # 查看桥接日志（Ctrl-C 退出）
cc-bridge health          # 探测 /health
cc-bridge help            # 完整帮助

cc-bridge glm start       # 显式指定上游
cc-bridge kimi start      # 预留上游 → 提示「未实现」
```

`cc-bridge claude` 只为那次 `claude` 进程导出桥接环境变量，并在退出时清理桥接：

```bash
cc-bridge claude -p "hello"
cc-bridge claude -- -p "hello"   # 也接受 "--" 分隔符
```

### 让 claude 持久使用桥接

`cc-bridge`（start / daemon）只在后台运行服务——你平常的 `claude` 不会自动用它。任选其一：

- **单次会话：** `cc-bridge claude`（自动处理环境变量 + 清理）。
- **手动（服务已运行时）：**
  ```bash
  export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
  export ANTHROPIC_API_KEY="$(grep -E '^API_KEY' ~/.cc-bridge/glm.env | head -1 | cut -d= -f2- | cut -d, -f1 | tr -d '\"')"
  export ANTHROPIC_MODEL=claude-opus-4-8
  claude
  ```
  （桥接会轮换自己配置的 KEY；这里的 `ANTHROPIC_API_KEY` 只需非空，让 claude CLI 肯发请求。）
- **持久：** 在 `~/.claude/settings.json` 的 `env` 块里设置 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_MODEL`。（此时 `claude` 只在桥接运行时才能用。）

在 `claude` 里运行 `/effort` 并选 `xhigh`（**不要**选 `max`——见上方警告）。桥接会记录每个请求，包括当前用的 KEY：

```
[bridge 2026-07-24T03:00:00.000Z] POST /v1/messages  model=claude-opus-4-8 → glm-5.2  effort=xhigh  stream=true  key=#1/2
[bridge …]   ← 200  812ms  ct=text/event-stream  key=#1
```

## 多 KEY 容灾

把多个 KEY 各自成行配成编号变量（`API_KEY_1=…`、`API_KEY_2=…`、`API_KEY_3=…`，每行一个；旧式逗号分隔 `API_KEY=k1,k2,k3` 也兼容），共用同一个 `API_BASE`。桥按下列规则决定是否轮换 KEY：

| 上游信号                                   | 桥接的动作                                                        |
|--------------------------------------------|-------------------------------------------------------------------|
| `401` / `403`（KEY 失效 / 额度用尽）       | 熔断此 KEY 60 秒，**立即**切换到下一个 KEY 重试                    |
| `429` / `5xx` / 网络瞬态错误               | 先在**同一** KEY 上重试（至多 2 次，200 ms / 500 ms 退避）；仍失败再切换到下一个 KEY |
| `400` / `404`（非瞬态业务错误）            | 原样返回客户端——换 KEY 无济于事                                    |
| 所有 KEY 都试遍仍失败                      | 把最后的错误返回客户端（401/403 → `authentication_error`，其余 → `api_error`） |

- **熔断是软优化，不是硬约束。** 被 `401`/`403` 判死的 KEY 会被跳过 60 秒，避免每条请求都先撞一次已知坏 KEY。60 秒后重新尝试。若所有 KEY 恰好都在熔断期，仍会挑一个相对可用的试。
- **瞬态错误不熔断 KEY。** `5xx` 或网络抖动是网关问题，不是 KEY 的错——不连累无辜 KEY。
- **重试有界。** 每条请求最多尝试 `KEY 数 ×（1 + 2 次重试）` 次，容灾总会终止。

## 始终 max 思考（GLM）

GLM adapter 设了 `forceMaxEffort: true`，每条请求都强制 `reasoning_effort = max`、`output_config.effort = max`、`thinking.type = enabled`——三条保险让 GLM-5.2 始终以最高思考等级运行，不受客户端 `/effort` 档位影响。在 [cc-glm-bridge/adapter.js](cc-glm-bridge/adapter.js) 里把 `forceMaxEffort` 设为 `false` 可退回「跟随客户端 effort」的行为。

## 添加新上游

CC-BRIDGE 就是为扩展而设计的。新增一个上游（如 `kimi`）：

1. **创建 adapter** `cc-kimi-bridge/adapter.js`，实现 adapter 接口（见 [cc-glm-bridge/adapter.js](cc-glm-bridge/adapter.js) 和 [core/adapter.js](core/adapter.js) 的注释）：
   - `name`、`displayName`、`defaultTarget`、`defaultSpoof`
   - `forceMaxEffort`（是否强制最高思考等级）
   - `modelMaxTokens`（`{ 模型ID: 最大输出token }`）
   - `adaptRequestBody(obj, ctx)`——为该上游适配 Anthropic 请求体；`ctx = { target }`
2. **注册** 在 [core/adapter.js](core/adapter.js) 里把 `kimi` 的 `implemented` 改为 `true`。
3. **文档** 写 `cc-kimi-bridge/README.md`，按需补配置模板。

完成——框架、CLI、多 KEY 容灾、daemon 全部无需改动即可工作。用户随后用 `cc-bridge kimi start`、编辑 `~/.cc-bridge/kimi.env` 等。

## 文件

| 路径                      | 用途                                              |
|---------------------------|---------------------------------------------------|
| `bin/cc-bridge.js`        | CLI 入口——`[upstream] <command>` 分发             |
| `core/server.js`          | 桥接服务器：model 改写、多 KEY 容灾、modelUsage 注入 |
| `core/adapter.js`         | 上游注册表 + adapter 加载器                        |
| `core/config.js`          | 按上游的配置查找 / 编辑 / 导入 / 展示              |
| `core/daemon.js`          | 后台进程管理（按上游的 pid + 日志）                |
| `core/claude.js`          | 启动桥接 + 通过它启动 `claude`                    |
| `core/util.js`            | 端口清理 / health 探测 / 就绪等待                 |
| `cc-glm-bridge/adapter.js`   | GLM（z.ai GLM-5.2）adapter——请求体适配、强制 max、模型上限表 |
| `cc-kimi-bridge/`、`cc-qwen-bridge/` | 预留占位（adapter + README）                |
| `cc-<name>-bridge/<name>.env.example` | 按上游的配置模板（GLM 已填；Kimi/Qwen 预留）  |
| `~/.cc-bridge/<upstream>.env` | 真实配置（你的，gitignored，绝不打包）        |

## 注意 / 限制

- **必须用 `xhigh`；`max` 在 VS Code 插件里是坏的。** VS Code 扩展（≥2.1.187）按 `["low","medium","high","xhigh"]` 校验 `effortLevel`——`max` 不在枚举里，会被静默强制为 `undefined`（→ 回落到 `high`）。`xhigh` 两者都接受。
- 上游必须接受 `output_config.effort` / `reasoning_effort`，effort 解锁（和强制 max）才会生效。
- 只有 `POST /v1/messages`（不含 `/v1/messages/count_tokens`）的 `model` 会被改写。其他路径原样转发。
- **未知模型会被 HTTP 400 拒绝，绝不静默改写。**
- `package.json` 的 `files` 排除了 `.env`；真实密钥绝不打包进全局安装。
- effort 解锁只绕过**客户端**的 effort 闸门。它不改变模型对 effort 参数实际做什么——那取决于上游。

## 版本管理

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。当前版本见 [VERSION](VERSION)；所有变更记录在 [CHANGELOG.md](CHANGELOG.md)。

## 开发

本目录是**开发工作区**——你编辑、推送到 git 的源码。最终用户安装发布版的构建 tarball。流程：在此编辑 → 测试 → bump 版本 → 发布 → 安装使用。

```bash
git clone <repo> && cd CC-BRIDGE
node --check core/*.js bin/cc-bridge.js cc-glm-bridge/adapter.js   # 改完做语法检查
cc-bridge glm start                                             # 从源码后台运行
```

### 发布新版本

1. 更新 `VERSION` 与 `package.json` 的 `version`（保持一致）。
2. 在 `CHANGELOG.md` 顶部加 `## [X.Y.Z] - YYYY-MM-DD` 条目。
3. `git commit -a -m "release vX.Y.Z"` 后 `git tag vX.Y.Z`。
4. `npm pack` → 把 `cc-bridge-<版本>.tgz` 上传到 GitHub Release。
5. 在目标机器上从 Release 安装（见[安装](#安装)）。

## 版权与署名

CC-BRIDGE 基于 **MIT 许可证** 开源——见 [LICENSE.md](LICENSE.md)。

版权所有 (c) 2026 **All Contributors**。

**署名方式：** 如果 CC-BRIDGE 对你有帮助，欢迎致谢（非强制）。请在任何副本或衍生项目中保留版权声明与许可证文件，并注明来源：https://github.com/xhqing/CC-BRIDGE。
