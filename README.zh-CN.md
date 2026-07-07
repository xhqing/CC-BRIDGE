# claude-proxy — Claude Code effort 解锁代理

一个本地透明代理，让 Claude Code 能对第三方模型（通过 Anthropic 兼容或 OpenAI 兼容网关接入，例如 z.ai · `glm-5.2`、SiliconFlow、小米 MiMo）使用 **`/effort max`**（以及 `xhigh`）。支持同时配置多个上游/模型对。

安装一次后，在**任意目录**下用一条命令即可启动：`claude-proxy`。

> [English](README.md)

> ⚠️ **一律使用 `/effort xhigh`，绝不使用 `/effort max`。** 当前版本的 VS Code 插件里 `max` **完全不可用** —— 它不在插件的 `effortLevel` 枚举里，会被静默强制回 `high`，于是 glm-5.2 实际并不会以 `max` 运行。要让 glm-5.2 的思考等级稳定保持在最高档，请在 **CLI 和 VS Code 插件** 两边统一使用 `/effort xhigh`。`xhigh` 是 VS Code 插件支持的最高档位，CLI 和插件都接受。（详见 [注意 / 限制](#注意--限制)。）

## 为什么需要

Claude Code 把 `max`/`xhigh` 这两档 effort 卡在**客户端**检查上：当前模型 ID 必须在 Claude 白名单里（`claude-opus-4-8` 等），**或者** provider 必须是官方 / Bedrock / Foundry。第三方网关两条都不满足，于是 `/effort max` 会静默回落到 `high`。

本代理通过给 Claude Code 喂一个白名单内的伪模型 ID 来绕过这个检查，同时在请求真正发往上游之前把模型改回真实模型。上游本身就说原生 Anthropic API，所以代理只改写 `body.model` —— 消息结构、工具调用、SSE 事件、`output_config.effort` 全部原样透传。

```
Claude Code  ──model=claude-opus-4-8, effort=max──▶  proxy (127.0.0.1:8787)
                                                       │ rewrite body.model → glm-5.2
                                                       ▼
                              upstream（z.ai / SiliconFlow / MiMo …）  ◀── 200 + thinking/SSE
```

## 前置条件

- **Node.js ≥ 14** 和 **npm**，在 PATH 中可用。
  - Homebrew 用户：如果 `which node` 没输出，说明 keg 没链接。运行 `brew link --overwrite node@22`，并确保 `/opt/homebrew/bin` 在 PATH 中（Homebrew 的标准前缀 —— 没有的话在 shell 配置里加 `export PATH="/opt/homebrew/bin:$PATH"`）。

## 安装

```bash
cd claude-proxy
npm install -g .
```

> 权限不足？用 `sudo npm install -g .`，或者一次性设一个用户可写的前缀（`npm config set prefix ~/.local`，确保 `~/.local/bin` 在 PATH 中）后再不带 sudo 运行。

安装后，`claude-proxy` 就在 PATH 中，任意目录可用 —— 无文件后缀、无路径前缀、无 `bash`/`sh`。

## 配置

配置位于 `~/.claude-proxy/.env`（用户级，所以在任意工作目录都能找到 —— 不再绑定项目目录）。

一步迁移已有的项目 `.env`：

```bash
claude-proxy config --import /path/to/claude-proxy/.env
```

……或交互式编辑（首次运行会从模板生成）：

```bash
claude-proxy config        # 用 $EDITOR 打开 ~/.claude-proxy/.env
claude-proxy config show   # 打印当前值（API_KEY 脱敏）
claude-proxy config path   # 打印配置文件路径
```

```ini
# --- Pair #1：OpenAI 兼容网关（FORMAT=openai）---
API_BASE=https://api.xiaomimimo.com
API_KEY="your_real_key"
TARGET_MODEL=mimo-v2.5-pro     # 上游识别的真实模型名
SPOOF_MODEL=claude-haiku-4-5   # Claude Code 看到的白名单 ID（解锁 max）
FORMAT=openai                  # anthropic ↔ openai（/v1/chat/completions）
CONTEXT_WINDOW=1000000         # 注入到用量显示
PROXY_PORT=8787
PROXY_LOG=1                    # 0 关闭每请求日志

# --- Pair #2：Anthropic 原生网关（数字后缀 _2、_3、…）---
# API_BASE_2=https://api.z.ai/api/anthropic
# API_KEY_2="your_real_key"
# SPOOF_MODEL_2=claude-opus-4-8
# TARGET_MODEL_2=glm-5.2
# FORMAT_2=anthropic            # 原生 /v1/messages 透传（默认）
```

> `SPOOF_MODEL` 必须是 Claude Code 白名单对你想要的档位认可的模型：`claude-opus-4-8` / `claude-opus-4-7` 同时解锁 `max` 和 `xhigh`。上游永远看不到这个值 —— 代理会把它改写回 `TARGET_MODEL`。
>
> **多对配置：** 每加一对 `SPOOF_MODEL_n` / `TARGET_MODEL_n` 就多一条路由。把 Claude Code 指向你想用的伪模型 ID（如 `ANTHROPIC_MODEL=claude-opus-4-8`），代理会路由到该对的上游，必要时转换格式。**未知模型（无匹配 spoof/target）会被 HTTP 400 拒绝**，绝不静默改写到默认对。

## 用法

```bash
claude-proxy start           # 前台启动（Ctrl-C 停止）
claude-proxy daemon          # 后台启动（detached）
claude-proxy claude [args]   # 启动代理 + 启动指向它的 claude
claude-proxy stop            # 停止后台服务
claude-proxy status          # 查看运行状态
claude-proxy logs            # 查看代理日志（Ctrl-C 退出）
claude-proxy health          # 探测 /health
claude-proxy help            # 完整帮助
```

`claude-proxy`（无参数）会打印帮助而非启动服务，避免误触。

`claude-proxy claude` 只为那次 `claude` 进程导出代理环境变量，并在退出时清理代理。向 `claude` 透传额外参数：

```bash
claude-proxy claude -p "hello"
claude-proxy claude -- -p "hello"   # 也接受 "--" 分隔符
```

### 让 claude 持久使用代理

`claude-proxy start` / `daemon` 只运行服务 —— 你平常的 `claude` 不会自动用它。任选其一：

- **单次会话：** `claude-proxy claude`（自动处理环境变量 + 清理）。
- **手动（服务已运行时）：**
  ```bash
  export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
  export ANTHROPIC_API_KEY="$(grep ^API_KEY ~/.claude-proxy/.env | cut -d= -f2- | tr -d '\"')"
  export ANTHROPIC_MODEL=claude-opus-4-8
  claude
  ```
- **持久：** 在 `~/.claude/settings.json` 的 `env` 块里设置 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_MODEL`。（此时 `claude` 只在代理运行时才能用。）

在 `claude` 里运行 `/effort` 并选 `xhigh`（**不要**选 `max` —— 见上方警告）。代理会记录每个请求，包括真正发往上游的 `effort`：

```
[proxy] POST /v1/messages  model=claude-opus-4-8 → glm-5.2  effort=xhigh  stream=true
[proxy]   ← 200  812ms  ct=text/event-stream
```

## 文件

| 路径                      | 用途                                              |
|---------------------------|---------------------------------------------------|
| `bin/claude-proxy.js`     | CLI 入口 —— 子命令分发                            |
| `lib/server.js`           | 代理服务器（透明透传）                            |
| `lib/config.js`           | 配置查找 / 编辑 / 导入 / 展示（脱敏）             |
| `lib/daemon.js`           | 后台进程管理（pid + 日志）                        |
| `lib/claude.js`           | 启动代理 + 通过它启动 `claude`                    |
| `lib/util.js`             | 端口清理 / health 探测 / 就绪等待                 |
| `.env.example`            | 文档化模板（随包发布）                            |
| `~/.claude-proxy/.env`    | 真实配置（你的，gitignored，绝不打包）            |

## 注意 / 限制

- **必须用 `xhigh`；`max` 在 VS Code 插件里是坏的。** VS Code 扩展（≥2.1.187）会按 `["low","medium","high","xhigh"]` 校验 `effortLevel` —— `max` 不在枚举里，会被静默强制为 `undefined`（→ 回落到 `high`）。CLI 接受 `max`，但 `max` 值在 CLI 能用却会破坏 VS Code 扩展。`xhigh` 两者都接受，且是 VS Code 扩展支持的最高档位。避免在 CLI 里用 `/effort max` —— 它会把 `effortLevel` 改回 `max`，再次破坏 VS Code 扩展。这也是顶部警告要求一律使用 `xhigh` 的原因。
- 上游必须接受 `output_config.effort`（Anthropic 格式）或 `reasoning_effort`（OpenAI 格式）。z.ai/SiliconFlow 的 `glm-5.2` 和小米 MiMo 都会据此产出 `thinking` 块 —— 参数被尊重，不会静默丢弃。
- 只有 `POST /v1/messages` 的 `model` 会被改写。其他所有路径（`/v1/models`、`/v1/messages/count_tokens` 等）原样转发。
- **未知模型会被 HTTP 400 拒绝，绝不静默改写。** 传入的 `model` 必须匹配某个已配置的 `SPOOF_MODEL` 或 `TARGET_MODEL`；否则代理直接报错，而不是兜底到默认对 —— 这样你始终知道自己实际在用哪个模型。
- `package.json` 的 `files` 排除了 `.env`；真实密钥绝不打包进全局安装。配置只留在 `~/.claude-proxy/.env`。
- 这只影响**客户端的 effort 闸门**。它不改变模型对 effort 参数实际做什么 —— 那取决于上游。

## 版本管理

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。当前版本见 [VERSION](VERSION)；所有变更记录在 [CHANGELOG.md](CHANGELOG.md)。

## 开发

本目录（`claude-proxy/`）是**开发工作区** —— 你编辑、推送到 git 的源码。最终用户**不会**保留它，而是 `npm install -g claude-proxy@<版本>` 安装发布版。流程是：在此编辑 → 测试 → bump 版本 → 发布 → 安装使用。

```bash
git clone <repo> && cd claude-proxy
node --check lib/server.js lib/openai-bridge.js   # 改完做语法检查
claude-proxy start                                 # 从源码前台运行
```

### 发布新版本

1. 更新 `VERSION` 与 `package.json` 的 `version`（按 SemVer：patch / minor / major）。
2. 在 `CHANGELOG.md` 顶部加 `## [X.Y.Z] - YYYY-MM-DD` 条目。
3. `git commit -a -m "release vX.Y.Z"` 后 `git tag vX.Y.Z`。
4. `npm publish`（发布前先去掉 `package.json` 里的 `"private": true`）。
5. 用户用 `npm install -g claude-proxy@X.Y.Z` 安装。
