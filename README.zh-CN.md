# claude-proxy —— 面向 Claude Code 的多上游模型中转代理

> [English](README.md)

一个本地透明代理，让 **Claude Code 通过一个本地端点访问多个第三方上游模型**。每个上游可以使用 **Anthropic** 接口格式（`/v1/messages`），也可以使用 **OpenAI** 接口格式（`/v1/chat/completions`）；代理按模型路由请求、在需要时转换通信格式，并针对不同上游（GLM / SiliconFlow / MiMo 等）适配请求体。作为附带效果，借助白名单伪模型 ID 中转，它也能为非官方 provider 解锁 `/effort xhigh`。

安装一次后，在**任意目录**下用一条命令即可启动：`claude-proxy`。

## 它能做什么

- **多上游路由。** 可配置任意数量的模型对（`SPOOF_MODEL` ↔ `TARGET_MODEL`），每对携带各自的上游地址、API 密钥、通信格式和上下文窗口元数据。Claude Code 指向某个伪模型 ID，代理把 `body.model` 改写为该对的真实模型并转发到对应上游。**未知模型会被 HTTP 400 拒绝**，绝不静默改写到默认对。
- **双格式支持。** `FORMAT=anthropic` 原样透传 `/v1/messages`；`FORMAT=openai` 由 [lib/openai-bridge.js](lib/openai-bridge.js) 做双向转换——请求体、非流式响应、**流式 SSE**、工具调用 / 工具结果、system 提示、停止原因，以及 `reasoning_content` → Anthropic `thinking` 块（让推理过程在 Claude Code 里可见）。
- **按上游适配请求体。** 转发前，代理会针对目标上游归一化 Anthropic 请求体——见[请求体适配](#请求体适配)。
- **解锁 effort。** 通过白名单伪模型 ID 中转，绕过 Claude Code 客户端的 effort 闸门，让第三方网关也能用 `/effort xhigh`。（见[effort 闸门（xhigh 与 max）](#effort-闸门xhigh-与-max)。）
- **上下文窗口上报。** 每对配置的 `CONTEXT_WINDOW` / `MAX_OUTPUT_TOKENS` 会被注入响应的 `modelUsage`，让 Claude Code 的 webview 显示**真实**模型的窗口，而非伪模型 ID 的默认值。
- **零运行时依赖。** 仅用 Node ≥ 14 内置模块。

## 工作原理

```
                              ┌── pair #1  FORMAT=anthropic ──▶ z.ai · glm-5.2
Claude Code ──POST /v1/messages──▶  proxy (127.0.0.1:8787)
  model = <伪模型 ID>               · 按模型路由                 └── pair #2  FORMAT=openai ──▶ MiMo / SiliconFlow …
                                    · 改写 body.model → 真实模型
                                    · 按上游适配请求体
                                    · FORMAT=openai 时转换 Anthropic ↔ OpenAI
                                    · 向响应注入 modelUsage
```

Pair #1 使用不带编号的键（`API_BASE`、`API_KEY`、`SPOOF_MODEL`、`TARGET_MODEL`……）。其余模型对用数字后缀（`_2`、`_3`……），各自有独立上游；省略时回退到 pair #1 的 `API_BASE` / `API_KEY`，所以一个上游服务多个模型时配置更省事。

## effort 闸门（xhigh 与 max）

> ⚠️ **一律使用 `/effort xhigh`，绝不使用 `/effort max`。** 当前版本的 VS Code 插件里 `max` **完全不可用**——它不在插件的 `effortLevel` 枚举里，会被静默强制回 `high`，于是模型实际并不会以 `max` 运行。要让思考等级稳定保持在最高档，请在 **CLI 和 VS Code 插件** 两边统一使用 `/effort xhigh`。`xhigh` 是 VS Code 插件支持的最高档位，CLI 和插件都接受。

Claude Code 把 `max`/`xhigh` 两档 effort 卡在**客户端**检查上：当前模型 ID 必须在 Claude 白名单里（`claude-opus-4-8` 等），**或者** provider 必须是官方 / Bedrock / Foundry。第三方网关两条都不满足，于是 `/effort max` 会静默回落到 `high`。通过本代理用白名单伪模型 ID 中转就能通过检查；代理随后在请求真正发往上游之前把 `body.model` 改写回真实模型——于是上游看到真实模型名，而 Claude Code 看到的是白名单 ID。

## 前置条件

- **Node.js ≥ 14** 和 **npm**，在 PATH 中可用。
  - Homebrew 用户：如果 `which node` 没输出，说明 keg 没链接。运行 `brew link --overwrite node@22`，并确保 `/opt/homebrew/bin` 在 PATH 中（Homebrew 的标准前缀——没有的话在 shell 配置里加 `export PATH="/opt/homebrew/bin:$PATH"`）。

## 安装

```bash
cd claude-proxy
npm install -g .
```

> 权限不足？用 `sudo npm install -g .`，或者一次性设一个用户可写的前缀（`npm config set prefix ~/.local`，确保 `~/.local/bin` 在 PATH 中）后再不带 sudo 运行。

安装后，`claude-proxy` 就在 PATH 中，任意目录可用——无文件后缀、无路径前缀、无 `bash`/`sh`。

## 配置

配置位于 `~/.claude-proxy/.env`（用户级，所以在任意工作目录都能找到——不再绑定项目目录）。

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
SPOOF_MODEL=claude-opus-4-8    # Claude Code 看到的白名单 ID
FORMAT=openai                  # anthropic ↔ openai（/v1/chat/completions）
CONTEXT_WINDOW=1048576         # 注入到 webview 的用量显示
MAX_OUTPUT_TOKENS=131072       # 同上
PROXY_PORT=8787
PROXY_LOG=1                    # 0 关闭每请求日志

# --- Pair #2：Anthropic 原生网关（数字后缀 _2、_3……）---
# API_BASE_2=https://api.z.ai/api/anthropic
# API_KEY_2="your_real_key"
# SPOOF_MODEL_2=claude-opus-4-8
# TARGET_MODEL_2=glm-5.2
# FORMAT_2=anthropic            # 原生 /v1/messages 透传（默认）
# CONTEXT_WINDOW_2=131072
# MAX_OUTPUT_TOKENS_2=131072
```

每对的键（`_2`、`_3`……）：`API_BASE_n`、`API_KEY_n`、`SPOOF_MODEL_n`、`TARGET_MODEL_n`、`FORMAT_n`、`CONTEXT_WINDOW_n`、`MAX_OUTPUT_TOKENS_n`。带编号的对至少需要 `SPOOF_MODEL_n` + `TARGET_MODEL_n`，其余回退到 pair #1。

> **路由：** 传入的 `model` 必须匹配某个已配置的 `SPOOF_MODEL` 或 `TARGET_MODEL`。匹配 spoof 时改写为对应真实模型并路由到该对上游；匹配 target 时原样透传但同样走该对上游。其余一律**被 HTTP 400 拒绝**，绝不静默改写到默认对，这样你始终知道自己实际在用哪个模型。
>
> **选择 `SPOOF_MODEL`：** 必须是 Claude Code 白名单接受的模型。`claude-opus-4-8` / `claude-opus-4-7` 同时解锁 `max` 和 `xhigh`；上游永远看不到这个值——代理会把它改写回 `TARGET_MODEL`。把 Claude Code 指向你想用的伪模型 ID（如 `ANTHROPIC_MODEL=claude-opus-4-8`），代理会据此路由。

## 用法

```bash
claude-proxy start           # 前台启动（Ctrl-C 停止）
claude-proxy daemon          # 后台启动（detached）
claude-proxy claude [args]   # 启动代理 + 启动指向它的 claude
claude-proxy stop            # 停止后台服务
claude-proxy restart         # 重启后台服务（stop + start）
claude-proxy status          # 查看运行状态
claude-proxy logs            # 查看代理日志（Ctrl-C 退出）
claude-proxy health          # 探测 /health
claude-proxy help            # 完整帮助
```

`claude-proxy claude` 只为那次 `claude` 进程导出代理环境变量，并在退出时清理代理。向 `claude` 透传额外参数：

```bash
claude-proxy claude -p "hello"
claude-proxy claude -- -p "hello"   # 也接受 "--" 分隔符
```

### 让 claude 持久使用代理

`claude-proxy`（前台 / daemon）只运行服务——你平常的 `claude` 不会自动用它。任选其一：

- **单次会话：** `claude-proxy claude`（自动处理环境变量 + 清理）。
- **手动（服务已运行时）：**
  ```bash
  export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
  export ANTHROPIC_API_KEY="$(grep ^API_KEY ~/.claude-proxy/.env | cut -d= -f2- | tr -d '\"')"
  export ANTHROPIC_MODEL=claude-opus-4-8
  claude
  ```
- **持久：** 在 `~/.claude/settings.json` 的 `env` 块里设置 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_MODEL`。（此时 `claude` 只在代理运行时才能用。）

在 `claude` 里运行 `/effort` 并选 `xhigh`（**不要**选 `max`——见上方警告）。代理会记录每个请求，包括真正发往上游的 `effort`：

```
[proxy] POST /v1/messages  model=claude-opus-4-8 → glm-5.2  effort=xhigh  stream=true  fmt=anthropic  upstream=https://api.z.ai/api/anthropic
[proxy]   ← 200  812ms  ct=text/event-stream
```

## 请求体适配

转发 `/v1/messages` 请求前，代理会针对目标上游归一化 Anthropic 请求体（在 `rewriteBody` 中）。归一化后的同一份请求体既喂给 Anthropic 透传，也喂给 OpenAI 桥接，所以 `reasoning_effort` 在两种格式下都生效。

| 适配项 | 原因 |
|--------|------|
| `thinking.type: adaptive → enabled` | z.ai 只接受 `enabled` / `disabled` |
| 把 `output_config.effort` 映射为 `reasoning_effort`（`max`/`xhigh → max`，`high`/`medium`/`low → high`，`minimal`/`none → none`） | 双保险，防止 `output_config` 被忽略 |
| MiMo 上游：强制 `reasoning_effort = high` | MiMo 不认 GLM 的 `max` / `none` 值 |
| SiliconFlow 上游：强制 `thinking.budget_tokens = 32768` 并启用 thinking | 把思考预算钳到 SiliconFlow 文档的最大值 |
| 剥离 `context_management` | Claude Code 专有，上游不识别 |
| 清空 `metadata.user_id` | 设备指纹 / session_id 发给上游无意义且泄露隐私 |
| 递归剥离 `cache_control`（messages / system / tools） | z.ai 返回 `cache_read_input_tokens = 0`，标记是冗余 |
| 把 `max_tokens` 钳到目标模型上限（GLM 系列表） | 避免过大请求被拒 |
| 剥离 Anthropic 专有 `system` 段（`x-anthropic-billing-header:`、`You are a Claude agent, built on Anthropic`） | Anthropic 专有，对第三方上游无意义 |
| 给 `tools` 数组尾部打 `cache_control`（仅 Anthropic 格式对） | 触发上游的 context caching |

`PROXY_DUMP=1` 会把每次改写后的请求体写入 `dumps/`，方便验证适配是否生效。

## 文件

| 路径                      | 用途                                              |
|---------------------------|---------------------------------------------------|
| `bin/claude-proxy.js`     | CLI 入口——子命令分发                              |
| `lib/server.js`           | 代理服务器：路由、请求体适配、modelUsage 注入      |
| `lib/openai-bridge.js`    | Anthropic ↔ OpenAI 格式桥接（请求 / 响应 / 流式 SSE）|
| `lib/config.js`           | 配置查找 / 编辑 / 导入 / 展示（脱敏）             |
| `lib/daemon.js`           | 后台进程管理（pid + 日志）                        |
| `lib/claude.js`           | 启动代理 + 通过它启动 `claude`                    |
| `lib/util.js`             | 端口清理 / health 探测 / 就绪等待                 |
| `.env.example`            | 文档化模板（随包发布）                            |
| `~/.claude-proxy/.env`    | 真实配置（你的，gitignored，绝不打包）            |

## 注意 / 限制

- **必须用 `xhigh`；`max` 在 VS Code 插件里是坏的。** VS Code 扩展（≥2.1.187）会按 `["low","medium","high","xhigh"]` 校验 `effortLevel`——`max` 不在枚举里，会被静默强制为 `undefined`（→ 回落到 `high`）。CLI 接受 `max`，但 `max` 值在 CLI 能用却会破坏 VS Code 扩展。`xhigh` 两者都接受，且是 VS Code 扩展支持的最高档位。避免在 CLI 里用 `/effort max`——它会把 `effortLevel` 改回 `max`，再次破坏 VS Code 扩展。这也是上方警告要求一律使用 `xhigh` 的原因。
- 上游必须接受 `output_config.effort`（Anthropic 格式）或 `reasoning_effort`（OpenAI 格式）。z.ai/SiliconFlow 的 `glm-5.2` 和小米 MiMo 都会据此产出 `thinking` 块——参数被尊重，不会静默丢弃。
- 只有 `POST /v1/messages`（不含 `/v1/messages/count_tokens`）的 `model` 会被改写。其他路径（`/v1/models` 等）原样转发。
- `/v1/messages/count_tokens` 在 OpenAI 格式下没有对应接口。对 `FORMAT=openai` 的对，代理返回本地粗估值（`请求体长度 / 4`），让 Claude Code 的上下文显示继续工作而不命中上游；对 `FORMAT=anthropic` 的对，原样转发给上游。
- **未知模型会被 HTTP 400 拒绝，绝不静默改写。** 传入的 `model` 必须匹配某个已配置的 `SPOOF_MODEL` 或 `TARGET_MODEL`；否则代理直接报错，而不是兜底到默认对。
- `package.json` 的 `files` 排除了 `.env`；真实密钥绝不打包进全局安装。配置只留在 `~/.claude-proxy/.env`。
- effort 解锁只绕过**客户端**的 effort 闸门。它不改变模型对 effort 参数实际做什么——那取决于上游。

## 版本管理

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。当前版本见 [VERSION](VERSION)；所有变更记录在 [CHANGELOG.md](CHANGELOG.md)。

## 开发

本目录（`claude-proxy/`）是**开发工作区**——你编辑、推送到 git 的源码。最终用户**不会**保留它，而是 `npm install -g claude-proxy@<版本>` 安装发布版。流程是：在此编辑 → 测试 → bump 版本 → 发布 → 安装使用。

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
