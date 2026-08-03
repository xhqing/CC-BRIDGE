# Changelog

本项目所有重要变更记录于此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Fixed

- **修复 `cc-bridge stats` 输出 token 恒为 0（流式请求）**：流式响应此前只从 `message_start` 事件的 `message.usage` 提取统计，而 Anthropic 规范里该 usage 只含输入侧统计（`input_tokens` / 缓存读写），`output_tokens` 恒为 0——真实输出数在流末尾 `message_delta` 事件的 `usage` 里才返回。DeepSeek 兼容端点严格按规范返回，故 `cc-bridge ds stats` 的 output 列恒为 0（glm 不受影响，因 z.ai 兼容实现在 `message_start` 就带出了 output_tokens）。本次在 `message_delta` 分支补提取 usage：`recordUsage` 新增 partial 模式（只补累计输出侧 token、不重复计请求数），无论是否注入 modelUsage 都解析累计（沿用 [2.7.1] 统计与注入解耦的原则）；`cache_creation_input_tokens` 一并补累计（实测 glm / ds 的 `message_start` 均无 creation，不会重复计数）。

## [2.7.1] - 2026-08-03

### Fixed

- **修复 `cc-bridge stats` 永远无数据（stats 不落盘）**：`core/server.js` 把 usage 统计（`recordUsage`）错误地放在「modelUsage 注入」分支内部——`buildModelUsage()` 在未配置 `CONTEXT_WINDOW` / `MAX_OUTPUT_TOKENS` 时返回 `null`，响应走直接 pipe 的提前返回，统计代码不可达，导致所有上游（glm / ds / mimo，均未配这两个参数）的 stats 快照从未写盘、缓存观测日志也从未输出（2.7.0 引入）。本次将统计与注入解耦：无论 `mu` 是否为 `null`，流式 / 非流式响应都走解析路径累计 usage（流式从 `message_start`、非流式从响应体）；modelUsage 注入保持仅在 `mu` 非空时进行，行为不变。

## [2.7.0] - 2026-08-02

### Added

- **按模型 token 统计（`cc-bridge stats <upstream>`）**：新增 CLI 命令与统计落盘，解决「缓存命中信息只有逐请求日志、无法看累计」的问题——此前每请求虽有 `cache(anthropic/openai)` 日志，但要看总量 / 命中率需自己 grep 日志手工算。
  - **采集（`core/server.js`）**：从上游响应的 `usage` 提取四个指标（输入 token、输出 token、缓存命中 token、缓存创建 token），按 **target 模型 ID** 分别累计；口径与既有 `formatCacheUsage` 一致（Anthropic 风格 `read+created+input` ≈ 总输入，OpenAI 风格 `prompt_tokens` 已含 cached），保证命中率 = 命中 / 总输入在单请求与汇总间一致。流式从 `message_start`、非流式从响应体取 usage；usage 结构无法识别时只计请求数、不计入 token，避免污染命中率口径。
  - **持久化**：内存累计 + 每 30s 节流写盘到 `~/.cc-bridge/stats-<upstream>.json`（随 config 目录，兼容 `$CC_BRIDGE_CONFIG` / `--config` 覆盖），SIGINT/SIGTERM 退出前强制写一次补上尾部数据——daemon 停掉后 `stats` 命令仍能读到最近快照。
  - **展示（新模块 `core/stats.js`）**：`cc-bridge stats <upstream>` 读快照排版输出，按模型分行 + 合计行（reqs / input / cache-hit / hit% / output），附统计时间窗口与文件路径；只读不依赖 daemon 运行。
  - **配套**：`core/config.js` 新增 `statsPathFor`（server 写盘与 CLI 读盘共用同一路径解析）；`bin/cc-bridge.js` 注册 `stats` 命令并更新 HELP；中英文 README 命令列表同步。

## [2.6.0] - 2026-08-01

### Added

- **DeepSeek bridge adapter（`cc-ds-bridge`）**：新增 `cc-ds-bridge/` 目录，含 `adapter.js`、`ds.env.example`、`README.md`，对接 DeepSeek-V4 系列（`deepseek-v4-pro` / `deepseek-v4-flash`），经 DeepSeek 官方 Anthropic 兼容端点（`https://api.deepseek.com/anthropic`）接入。在 `core/adapter.js` 注册表新增 `ds` 条目（`implemented: true`）。
  - **思考等级沿用 GLM 模型**：DeepSeek-V4 思考三态（Non-think / Think High / Think Max）与 GLM 的 `none` / `high` / `max` 一一对应，复用同一套 `MODEL_THINKING` 配置与三字段对称写入逻辑（`thinking.type` + `reasoning_effort` + `output_config.effort`）；默认端口 `8792`（glm 8788 / kimi 8789 / qwen 8790 / mimo 8791 / ds 8792）。
  - **与 GLM/MiMo 的差异**：DeepSeek 官方兼容表明确 `cache_control` 标记为 Ignored（其 Context Caching 是隐式自动的），故 adapter 不在 `tools` 尾部打 `cache_control`（GLM/MiMo 会打），仅剥离客户端的 `cache_control` 以避免请求体膨胀；缓存命中由 framework 从上游 `usage` 旁路观测。`metadata.user_id` 虽被 DeepSeek 支持（做限流隔离），但 CC 传的是设备指纹 / session_id，对单用户限流无意义且泄露隐私，仍清空（与 GLM/MiMo 一致）。
  - **模型上限**：DeepSeek-V4 上下文窗口 1M、单次输出能力充裕（官方未公布精确输出上限，第三方实测 flash 可达 384K），`MODEL_MAX_TOKENS` 钳制值取保守的 128K（与 GLM 一致），确保偶发超大 `max_tokens` 不被上游拒收；旧模型名 `deepseek-chat` / `deepseek-reasoner` 已于 2026/07/24 弃用，仅使用 V4 新名。

### Changed

- **`package.json` 同步**：`files` 数组补入 `cc-ds-bridge`（避免重蹈 [2.5.1] mimo 漏打包导致安装后 `Cannot find module` 的覆辙）；`version` bump 至 2.6.0；`description` / `keywords` 补上 DeepSeek。
- **CLI 帮助文案修正**：`bin/cc-bridge.js` 的 help 由静态的「only 'glm' is implemented so far」（自 [2.4.0] mimo 起即已过时）改为动态列举已实现上游（`listUpstreams().filter(isImplemented)`），新增导入 `isImplemented`。
- **顶层 README upstreams 清单补全**：中英文 README 的「可用上游」表此前遗漏了 `mimo`（[2.4.0] 已实现），本次随 `ds` 一并补入 `mimo` + `ds`；「当前已实现」说明与 Files 表同步更新。

## [2.5.2] - 2026-07-30

### Fixed

- **修复 MiMo 的 MODEL_THINKING 配置验证失败**：`parseModelThinking` 仅接受 GLM 的 `max`/`high`/`none` 等级，但 MiMo 使用 `enabled`/`disabled`。已扩展验证支持两种风格的思考等级。

## [2.5.1] - 2026-07-30

### Fixed

- **修复 `cc-mimo-bridge` 未包含在发布包中**：`package.json` 的 `files` 数组遗漏 `cc-mimo-bridge` 目录，导致 npm 安装后 `cc-bridge mimo start` 报错 `Cannot find module '../cc-mimo-bridge/adapter'`。已补充该目录。

## [2.5.0] - 2026-07-30

### Changed

- **`rollback` 支持指定版本**：`cc-bridge rollback`（或 `--rollback`）现在可以接受可选的版本号参数（如 `cc-bridge rollback 2.3.0`），回退到指定版本；不指定版本时保持原有行为（回退到上一个版本）。`core/update.js` 的 `runRollback()` 函数新增 `targetVersion` 参数；CLI 入口 `bin/cc-bridge.js` 将 `sub[0]` 传递给 `runRollback()`；帮助文本和示例同步更新。

## [2.4.1] - 2026-07-30

### Added

- **CLI `update` / `rollback` 命令**：`cc-bridge update`（或 `--update`）从 GitHub Release 自检并安装最新版 tgz；`cc-bridge rollback`（或 `--rollback`）回退到上一个 Release。依赖 `gh`（GitHub CLI）。实现位于 `core/update.js`，CLI 入口 `bin/cc-bridge.js` 新增对应 case 分支与 help 文本。

## [2.4.0] - 2026-07-30

### Added

- **Mimo bridge adapter**：新增 `cc-mimo-bridge/` 目录，包含 `adapter.js`、`mimo.env.example` 和 `README.md`，支持 Mimo 模型。在 `core/adapter.js` 的注册表中添加了 `mimo` 条目（`implemented: true`）。

## [2.3.0] - 2026-07-29

### Added

- **按模型配置思考等级（`MODEL_THINKING`）**：`~/.cc-bridge/glm.env` 新增 `MODEL_THINKING`（格式 `target->level,...`，取值 `max` / `high` / `none`）与 `MODEL_THINKING_DEFAULT`（未列出模型的兜底等级，默认 `max`），可对每个 GLM target 模型单独钉死思考等级、忽略 Claude Code 的 `/effort` 档位。`none` = 不思考（`thinking.type=disabled` + `reasoning_effort=none` + `output_config.effort=none` 三处对称写入）；`max` / `high` 启用思考并写入对应等级。

### Changed

- **移除全局 `forceMaxEffort` 开关**：原 GLM adapter 的 `forceMaxEffort: true` 一刀切强制所有模型 max 思考，改为按 target 模型查 `MODEL_THINKING` 决定等级；未配置时通过 `defaultThinking: 'max'` 保持原有「全 max」默认行为（向后兼容）。`core/config.js` 新增 `parseModelThinking` 解析；`cc-glm-bridge/adapter.js` 的 `adaptRequestBody` 按 `ctx.target` 查表、三字段对称写入；`core/server.js` 启动时注入配置并更新 banner；同步更新 `glm.env.example` 与全部 README（项目主文档 + glm / qwen / kimi bridge）。

## [2.2.5] - 2026-07-28

### Changed

- **CC 安全分类器改走 agnes 免费模型（双模型容灾）+ 三态开关**：重构分类器路由（取代 2.2.3/2.2.4「路由到 glm-4.5-flash」——后者在 Coding Plan 下仍占额度）。新增 `core/classifier.js`：识别 CC auto mode 安全分类器请求后，由 `CLASSIFIER_MODE` 控制：`on` = 走 agnes 免费模型（`agnes-2.5-flash` 主，请求失败立即切 `agnes-2.0-flash`），Anthropic Messages ↔ OpenAI chat completions 协议转换；`off` = 桥直接伪造 `<block>no</block>` 放行响应，不走任何模型（0 消耗，无安全判断）。分类器高频（约是主对话 3 倍）且原本吃 opus 倍率，是 z.ai Coding Plan 额度大头（~70%）；改走免费 agnes 后这部分 0 成本。agnes 在境外，自动走系统代理（`HTTPS_PROXY` 等）；z.ai 境内直连不变。`server.js` 在转发前拦截分类器请求；`adapter.js` 移除 2.2.4 的 flash 路由（分类器不再经 adapter）。

### Added

- **配置项**（`glm.env`，示例见 `glm.env.example`）：`CLASSIFIER_MODE`（on/off，默认 off）、`AGNES_API_BASE`、`AGNES_API_KEY`、`AGNES_MODEL_PRIMARY`、`AGNES_MODEL_FALLBACK`。
- **依赖**：`https-proxy-agent`（agnes 走系统代理用；node 的 https 不像 curl 自动读 HTTPS_PROXY）。

## [2.2.4] - 2026-07-28

### Fixed

- **修复 CC 安全分类器路由漏判**：2.2.3 引入的 `isClassifierRequest` 原用 `startsWith` 识别分类器 system，但 CC 发来的 system 第一个 block 是 billing header（`x-anthropic-billing-header:`），join 后字符串以 billing 开头，`startsWith("You are a security monitor...")` 漏判，导致分类器请求仍走 glm-5.2（没路由到 flash）。改为 `includes` 后正确识别（这段文字足够特定，不会误判其它请求）。即 2.2.3 的路由实际未生效，2.2.4 才真正让分类器走 glm-4.5-flash。

## [2.2.3] - 2026-07-28

### Changed

- **CC auto mode 安全分类器路由到 glm-4.5-flash**：`cc-glm-bridge/adapter.js` 新增 `isClassifierRequest()`，识别请求 system 以 "You are a security monitor for autonomous AI coding agents" 开头的 CC auto mode 安全分类器请求，将其从 glm-5.2 路由到免费的 glm-4.5-flash。CC auto 模式下，主 agent 每次工具调用前都会发一个请求给安全分类器判断该动作是否该 block——它高频（约是主对话请求数的 3 倍）且用 opus 倍率（高峰 3×、非高峰 2×），是 z.ai Coding Plan 额度消耗的大头（实测占 ~70%）。分类器属判断任务，不需要 glm-5.2 顶配，换 flash 后这部分不再消耗 Coding Plan 额度（flash 免费）。代价：安全判断降级到轻量模型（明显危险动作仍能拦，复杂 prompt injection 可能漏判，需使用者权衡）。同时，分类器走 flash 时不再强制 max reasoning（退回跟随客户端 effort），与 CC 自身「减少分类器 reasoning」的优化方向一致，降低分类器延迟。

## [2.2.2] - 2026-07-28

### Added

- **响应侧缓存命中观测日志**：`core/server.js` 新增 `formatCacheUsage()`，从上游响应的 usage 对象提取缓存命中信息（命中读取 / 写入 token 数、命中率），在 streaming 的 `message_start` 事件与 non-streaming 响应体里旁路记日志，不改写任何请求 / 响应内容。兼容 Anthropic 风格（`cache_read_input_tokens` / `cache_creation_input_tokens`）与 OpenAI 风格（`prompt_tokens_details.cached_tokens`）两种 usage 字段；上游未返回缓存字段时列出 usage 的 keys 便于诊断。受 `PROXY_LOG` 控制，关闭时零开销。用途是长期观测上游 context caching 是否生效、命中率随对话如何变化、上游规则是否变动——部分上游（如 z.ai）的缓存是隐式的（按内容相似度自动匹配、不读 `cache_control`），所以观测缓存的正确方向是看 usage，而非在请求体打 `cache_control`。

### Changed

- **`glm.env.example` 补充 `PROXY_DUMP` 配置说明**：模板顶部字段说明与配置块补上 `PROXY_DUMP`（改写后的请求体落盘到 `~/.cc-bridge/dumps/`，默认关、调试用），与 `core/server.js` 已有的 dump 能力对齐。

## [2.2.1] - 2026-07-27

### Fixed

- **GLM 配置模板 `API_BASE` 补上 `/api/anthropic` 路径前缀**：`cc-glm-bridge/glm.env.example`、`README.md`、`README.zh-CN.md` 里的 `API_BASE` 默认值由 `https://api.z.ai` 修正为 `https://api.z.ai/api/anthropic`。原值缺路径前缀，桥接把请求转发到 `https://api.z.ai/v1/messages`——z.ai 网关返回 HTML 404 页面，Claude Code 解析不了非 JSON 响应，抛出笼统的「selected model ... may not exist or you may not have access to it」（首次配置即不可用）。补上 `/api/anthropic` 后请求正确落到 z.ai 的 Anthropic 兼容端点 `https://api.z.ai/api/anthropic/v1/messages`。已按旧模板生成配置的用户：把 `~/.cc-bridge/glm.env` 的 `API_BASE` 改为 `https://api.z.ai/api/anthropic` 后 `cc-bridge restart` 即可。

## [2.2.0] - 2026-07-27

### Changed

- **`cc-bridge start` 改为后台启动**：`start` 不再以前台阻塞方式运行，改为与 `daemon` 一致的后台 detached 模式（调用 `startDaemon`）。`daemon` 命令保留为 `start` 的别名，两者行为完全一致，已有脚本与文档里的 `cc-bridge daemon` 不受影响。前台直接运行的能力收为内部隐藏命令 `_serve`（调试 / 直接 spawn 兜底用），用户面不再暴露前台启动方式。

## [2.1.2] - 2026-07-27

### Fixed

- **GLM 默认端口模板修正为 8788**：`cc-glm-bridge/glm.env.example` 的 `PROXY_PORT` 由 8787 改为 8788。8787 与仍服务主链路的旧 claude-proxy 冲突——复制模板生成 `~/.cc-bridge/glm.env` 时若忘改端口，cc-bridge daemon 会与 claude-proxy 抢同一端口，且 `cc-bridge restart` 会把 claude-proxy 当残留清掉。改为 8788 后两者并行不撞。
- **三上游默认端口顺延、互不冲突**：Kimi 模板 8788→8789、Qwen 模板 8789→8790，给 GLM 让出 8788；三个上游默认端口连续（GLM 8788 / Kimi 8789 / Qwen 8790），并存时各不撞。

### Changed

- **模板文件名改为 `<upstream>.env.example`**：三个上游的配置模板由 `.env.example` 重命名为 `<upstream>.env.example`（即 `glm.env.example` / `kimi.env.example` / `qwen.env.example`），与运行配置 `~/.cc-bridge/<upstream>.env` 命名对齐——看到模板名就知道它生成哪个运行配置。`core/config.js` 的 `templatePath()` 同步改为查找 `<upstream>.env.example`，各 README / 子目录 README 引用一并更新。
- **模板标注运行配置绝对路径**：三个 `cc-*-bridge/<upstream>.env.example` 顶部注明该上游运行配置最终落地路径（GLM → `~/.cc-bridge/glm.env`、Kimi → `~/.cc-bridge/kimi.env`、Qwen → `~/.cc-bridge/qwen.env`），避免复制模板后找错文件位置。

## [2.1.1] - 2026-07-27

### Added

- **API_KEY 编号变量写法**：`~/.cc-bridge/<upstream>.env` 里的 API KEY 除原逗号分隔写法（`API_KEY=k1,k2`）外，新增编号变量写法 `API_KEY_1=…` / `API_KEY_2=…` / `API_KEY_3=…`（每个 KEY 独立成行）。这样每个 KEY 可单独写注释标注账号来源，也可整行注释掉临时禁用某个 KEY——比在一长串逗号串里增删某个值方便。两种写法可混用、合并去空（编号变量在前、按数字大小升序排列，旧式 `API_KEY` 的值追加其后）。由 `core/config.js` 新增的 `collectKeys()` 统一收集。

### Changed

- **配置模板与文档同步**：三个 `cc-*-bridge/.env.example` 模板默认改为 `API_KEY_1` / `API_KEY_2` 编号写法（顶部字段说明、配置块、旧式写法兼容提示一并更新）；中英文 README 的「多 KEY 容灾」特性段与章节、配置示例、`ANTHROPIC_API_KEY` 提取脚本（改为 `grep -E '^API_KEY' … | head -1`，兼容编号变量与老式逗号串）一并更新。
- **validate 缺失提示**：未配任何 KEY 时，缺失项提示由 `API_KEY` 改为 `API_KEY_1 (or legacy API_KEY)`，指明推荐写法。

### 向后兼容

- 旧式 `API_KEY=k1,k2`（逗号分隔）仍完全支持，已有配置无需改动。

## [2.1.0] - 2026-07-25

新增「单上游多对模型映射」（MODEL_MAP），替代原单对 SPOOF_MODEL / TARGET_MODEL；配置模板按上游下沉到各 `cc-<name>-bridge/` 子目录。

### Added

- **MODEL_MAP 多对模型映射**：`MODEL_MAP` 支持逗号分隔的多对 `spoof->target`（如 `claude-opus-4-8->glm-5.2,claude-haiku-4-5->glm-5.2`），同一上游可把多个 Claude 白名单模型路由到真实模型——例如 opus 做主力、haiku 做轻量任务，两对都指向 glm-5.2。第一对约定为「主力对」，决定 `cc-bridge <upstream> claude` 启动 claude 时的默认模型。由 `core/config.js` 的 `parseModelMap()` 解析、`resolvePairs()` 派生路由对（供 server 与 daemon 共用）。旧的数字后缀多 pair（v2.0.0 移除的 `API_BASE_2` / `SPOOF_MODEL_2`）以显式、可读的 MODEL_MAP 形式回归。

### Changed

- **请求路由支持多对**：`core/server.js` 在 pairs 里查 `obj.model`——命中某对的 spoof 改写为该对 target、命中某对的 target 原样直传、都不命中返回 400（错误信息列出所有合法模型，绝不静默改写）。`modelUsage` 注入用所有出现过的 spoof / target 名作 key，确保多对时 CLI 取到哪个名都能命中真实上下文窗口。
- **配置模板按上游下沉**：`.env.example` 从仓库根目录移到各上游子目录 `cc-<name>-bridge/.env.example`；`core/config.js` 的 `templatePath(upstream)` 按 adapter 注册表定位对应模板，`ensureConfig` 首次生成 `~/.cc-bridge/<upstream>.env` 时复制该上游模板（找不到则写占位注释）。
- **向后兼容**：旧式单对写法 `SPOOF_MODEL` / `TARGET_MODEL` 仍完全兼容（等价于 MODEL_MAP 只写一对），已有配置无需改动。
- **banner 多对展示**：daemon 与 server 启动 banner 由 `resolvePairs(cfg, adapter)` 统一派生，展示多对 `spoof → target`（`|` 分隔）。

## [2.0.0] - 2026-07-24

重大重构：项目从「多上游模型代理（claude-proxy）」演化为「Claude Code 上游桥接框架（CC-BRIDGE）」。框架与上游适配器分层：通用逻辑在 `core/`，每个上游一个 `<name>-bridge/adapter.js`，先实现 GLM（z.ai GLM-5.2），预留 Kimi / Qwen。这是破坏性变更（breaking change），版本号升至 2.0.0。

### Added

- **CC-BRIDGE 框架 + adapter 架构**：新增 `core/`（server / adapter / config / daemon / claude / util）承载与上游无关的通用逻辑，上游专属逻辑（请求体适配、effort 映射、模型上限表）由各 `<name>-bridge/adapter.js` 实现统一接口（`name` / `displayName` / `defaultTarget` / `defaultSpoof` / `forceMaxEffort` / `modelMaxTokens` / `adaptRequestBody(obj, ctx)`）。新增上游只需加一个 adapter 文件 + 注册表（`core/adapter.js`）一行，框架、CLI、daemon 无需改动。
- **GLM adapter（glm-bridge/adapter.js）**：对接 z.ai GLM-5.2，移植原 z.ai 请求体适配（thinking 归一化、剥离 context_management / cache_control / Anthropic 专有 system 段、max_tokens 钳制、tools 尾部 cache_control）。
- **强制 GLM-5.2 始终 max 思考**：GLM adapter 设 `forceMaxEffort: true`，每条请求都强制 `reasoning_effort = max` + `output_config.effort = max` + `thinking.type = enabled`（三条保险），不受 Claude Code 的 `/effort` 档位影响。
- **多 API_KEY 容灾**：`API_KEY` 支持逗号分隔配置多个（推荐至少 2 个，共用同一 `API_BASE`）。某 KEY 返回 `401`/`403`（失效 / 欠费）时，桥熔断该 KEY 60 秒并立即切换下一个 KEY；瞬态错误（`429`/`5xx`/网络）先同 KEY 退避重试（`[200, 500]` ms）至多 2 次、用尽再换。所有 KEY 试遍才返回错误。URL 不变，只轮换 KEY。实现：`core/server.js` 的 `pickNextKey()` / `send()` + `KEY_BLOCK_SECONDS` 熔断表。
- **CLI `[upstream] <command>`**：`cc-bridge [upstream] <command>`，upstream 省略时默认 `glm`，可显式 `cc-bridge glm start` / `cc-bridge kimi start`（未实现上游会报错）。
- **按上游隔离的配置 / pid / 日志**：每个上游独立配置 `~/.cc-bridge/<upstream>.env`、pid 文件 `<upstream>.pid`、日志 `<upstream>.log`，多个上游可作为 daemon 并存（各用不同 `PROXY_PORT`）。
- **预留上游目录**：`kimi-bridge/`、`qwen-bridge/`（含 README 占位 + 扩展指南），`core/adapter.js` 注册表里 `implemented: false`。

### Changed

- **改名 cc-bridge**：CLI 命令、npm 包名、配置目录（`~/.cc-bridge/`）、环境变量（`$CC_BRIDGE_UPSTREAM` / `$CC_BRIDGE_CONFIG`）、日志前缀（`[bridge]`）全部由 `claude-proxy` 改为 `cc-bridge`。旧 `~/.claude-proxy/.env` 不再读取，需迁移到 `~/.cc-bridge/glm.env`。
- **目录结构调整**：`lib/` → `core/`（公共框架）；上游专属逻辑移入 `glm-bridge/`；新增 `kimi-bridge/`、`qwen-bridge/` 预留目录。
- **GitHub 仓库 rename**：`xhqing/claude-proxy` → `xhqing/CC-BRIDGE`。

### Removed

- `lib/openai-bridge.js`（OpenAI 格式互转层）与 `FORMAT` 配置项。
- 多 pair 路由（`API_BASE_2` / `SPOOF_MODEL_2` 数字后缀、`spoofToPair` / `targetToPair` 路由表）。
- SiliconFlow / MiMo 专用适配分支（已随多上游移除）。

### Migration（从 1.x 升级）

1. 卸载旧 `claude-proxy`，安装新版（`npm install -g cc-bridge-<版本>.tgz`）。
2. 迁移配置：把旧 `~/.claude-proxy/.env` 复制为 `~/.cc-bridge/glm.env`（或 `cc-bridge glm config --import <旧路径>`），把单条 `API_KEY` 改成逗号分隔的两条 z.ai KEY。
3. 删除所有 `_2` / `_3` 后缀的多 pair 配置和 `FORMAT` 行（不再支持）。
4. 命令由 `claude-proxy ...` 改为 `cc-bridge ...`（默认上游 glm，等价于 `cc-bridge glm ...`）。

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
