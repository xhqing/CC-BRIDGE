# claude-proxy — multi-upstream model proxy for Claude Code

> 中文文档：[README.zh-CN.md](README.zh-CN.md)

A local transparent proxy that lets **Claude Code talk to multiple third-party
upstream models through a single local endpoint**. Each upstream may speak
either the **Anthropic** API (`/v1/messages`) or the **OpenAI** API
(`/v1/chat/completions`); the proxy routes each request by model, translates the
wire format when needed, and adapts the request body per upstream
(GLM / SiliconFlow / MiMo …). As a side effect of routing through a spoofed
whitelist model, it also unlocks `/effort xhigh` for non-first-party providers.

Install it once and start it from **any directory** with a single command:
`claude-proxy`.

## What it does

- **Multi-upstream routing.** Configure any number of model *pairs*
  (`SPOOF_MODEL` ↔ `TARGET_MODEL`), each carrying its own upstream URL, API key,
  wire format, and context-window metadata. Claude Code points at a spoof ID;
  the proxy rewrites `body.model` to the paired real model and forwards to that
  pair's upstream. An unknown model is **rejected with HTTP 400** — never
  silently rewritten to a default.
- **Dual wire format.** `FORMAT=anthropic` passes `/v1/messages` through
  untouched. `FORMAT=openai` translates Anthropic ↔ OpenAI in both directions —
  request body, non-streaming response, **streaming SSE**, tool calls / tool
  results, system prompts, stop reasons, and `reasoning_content` → Anthropic
  `thinking` blocks (so reasoning is visible inside Claude Code).
- **Per-upstream body adaptation.** Before forwarding, the proxy normalizes the
  Anthropic request body for the target upstream — see
  [Request-body adaptation](#request-body-adaptation).
- **Effort unlock.** Routing via a spoofed whitelist model ID bypasses Claude
  Code's client-side effort gate, so `/effort xhigh` works with third-party
  gateways. (See [The effort gate](#the-effort-gate-xhigh-vs-max).)
- **Context-window reporting.** Each pair's configured `CONTEXT_WINDOW` /
  `MAX_OUTPUT_TOKENS` is injected into the response's `modelUsage`, so the
  Claude Code webview shows the *real* model's limits instead of the spoof ID's.
- **Zero runtime dependencies.** Node ≥ 14 built-ins only.

## How it works

```
                              ┌── pair #1  FORMAT=anthropic ──▶ z.ai · glm-5.2
Claude Code ──POST /v1/messages──▶  proxy (127.0.0.1:8787)
  model = <spoof ID>                · route by model            └── pair #2  FORMAT=openai ──▶ MiMo / SiliconFlow …
                                    · rewrite body.model → target
                                    · adapt the body per upstream
                                    · translate Anthropic ↔ OpenAI when FORMAT=openai
                                    · inject modelUsage into the response
```

Pair #1 uses the unnumbered keys (`API_BASE`, `API_KEY`, `SPOOF_MODEL`,
`TARGET_MODEL`, …). Additional pairs use numeric suffixes (`_2`, `_3`, …), each
with its own upstream — or they fall back to pair #1's `API_BASE` / `API_KEY`
when omitted, so a single upstream serving several models needs less typing.

## The effort gate (xhigh vs max)

> ⚠️ **Always use `/effort xhigh`, never `/effort max`.** In the current VS Code
> extension, `max` is **not usable** — it's absent from the extension's
> `effortLevel` enum and is silently coerced back to `high`, so the model never
> actually runs at `max`. To pin the thinking tier at the maximum, use
> `/effort xhigh` uniformly in **both** the CLI and the VS Code extension.
> `xhigh` is the highest tier the VS Code extension supports and is accepted by
> both.

Claude Code gates `max`/`xhigh` behind a **client-side** check: the active model
ID must be on a Claude whitelist (`claude-opus-4-8`, …) **or** the provider must
be first-party / Bedrock / Foundry. A third-party gateway fails both, so
`/effort max` silently falls back to `high`. Routing through this proxy with a
spoofed whitelist ID satisfies the check; the proxy then rewrites `body.model`
back to the real target before it hits the upstream — so the upstream sees the
real model name while Claude Code sees the whitelist ID.

## Prerequisites

- **Node.js ≥ 14** and **npm**, reachable from your PATH.
  - Homebrew users: if `which node` prints nothing, the keg isn't linked. Run
    `brew link --overwrite node@22`, and make sure `/opt/homebrew/bin` is on your
    PATH (Homebrew's standard prefix — add
    `export PATH="/opt/homebrew/bin:$PATH"` to your shell rc if it's missing).

## Install

```bash
cd claude-proxy
npm install -g .
```

> Permission denied? Either `sudo npm install -g .`, or set a user-writable
> prefix once (`npm config set prefix ~/.local`, ensure `~/.local/bin` is on
> PATH) and re-run without sudo.

After install, `claude-proxy` is on your PATH from any directory — no file
suffix, no path prefix, no `bash`/`sh`.

## Configure

Config lives at `~/.claude-proxy/.env` (user-level, so it's found from any
working directory — not tied to the project folder).

Migrate an existing project `.env` in one step:

```bash
claude-proxy config --import /path/to/claude-proxy/.env
```

…or edit interactively (a template is generated on first run):

```bash
claude-proxy config        # opens ~/.claude-proxy/.env in $EDITOR
claude-proxy config show   # prints current values (API_KEY masked)
claude-proxy config path   # prints the config file path
```

```ini
# --- Pair #1: OpenAI-compatible gateway (FORMAT=openai) ---
API_BASE=https://api.xiaomimimo.com
API_KEY="your_real_key"
TARGET_MODEL=mimo-v2.5-pro     # real model the upstream recognises
SPOOF_MODEL=claude-opus-4-8    # whitelisted ID Claude Code sees
FORMAT=openai                  # anthropic ↔ openai (/v1/chat/completions)
CONTEXT_WINDOW=1048576         # injected into the webview's usage display
MAX_OUTPUT_TOKENS=131072       #   "     "
PROXY_PORT=8787
PROXY_LOG=1                    # 0 to silence per-request logging

# --- Pair #2: Anthropic-native gateway (numeric suffix _2, _3, …) ---
# API_BASE_2=https://api.z.ai/api/anthropic
# API_KEY_2="your_real_key"
# SPOOF_MODEL_2=claude-opus-4-8
# TARGET_MODEL_2=glm-5.2
# FORMAT_2=anthropic            # native /v1/messages passthrough (default)
# CONTEXT_WINDOW_2=131072
# MAX_OUTPUT_TOKENS_2=131072
```

Per-pair keys (`_2`, `_3`, …): `API_BASE_n`, `API_KEY_n`, `SPOOF_MODEL_n`,
`TARGET_MODEL_n`, `FORMAT_n`, `CONTEXT_WINDOW_n`, `MAX_OUTPUT_TOKENS_n`. A
numbered pair needs at least `SPOOF_MODEL_n` + `TARGET_MODEL_n`; the rest fall
back to pair #1.

> **Routing:** the incoming `model` must match a configured `SPOOF_MODEL` or
> `TARGET_MODEL`. A spoof match is rewritten to its paired target and routed to
> that pair's upstream; a target match is passed through unchanged but still
> uses that pair's upstream. Anything else is **rejected with HTTP 400** — it is
> never silently rewritten to a default pair, so you always know which model
> you're actually hitting.
>
> **Choosing `SPOOF_MODEL`:** it must be a model Claude Code's whitelist accepts.
> `claude-opus-4-8` / `claude-opus-4-7` unlock both `max` and `xhigh`; the
> upstream never sees this value — the proxy rewrites it to `TARGET_MODEL`.
> Point Claude Code at whichever spoof ID you want
> (e.g. `ANTHROPIC_MODEL=claude-opus-4-8`) and the proxy routes accordingly.

## Usage

```bash
claude-proxy start           # start in foreground (Ctrl-C to stop)
claude-proxy daemon          # start in background (detached)
claude-proxy claude [args]   # start proxy + launch claude pointed at it
claude-proxy stop            # stop the background service
claude-proxy restart         # restart the background service (stop + start)
claude-proxy status          # show running status
claude-proxy logs            # tail the proxy log (Ctrl-C to exit)
claude-proxy health          # probe /health
claude-proxy help            # full help
```

`claude-proxy claude` exports the proxy env for that `claude` process only and
cleans the proxy up on exit. Forward extra args to `claude`:

```bash
claude-proxy claude -p "hello"
claude-proxy claude -- -p "hello"   # "--" separator also accepted
```

### Making `claude` use the proxy persistently

`claude-proxy` (foreground / daemon) only runs the service — your normal
`claude` won't use it automatically. Pick one:

- **One session:** `claude-proxy claude` (handles env + cleanup for you).
- **Manual, with the service running:**
  ```bash
  export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
  export ANTHROPIC_API_KEY="$(grep ^API_KEY ~/.claude-proxy/.env | cut -d= -f2- | tr -d '\"')"
  export ANTHROPIC_MODEL=claude-opus-4-8
  claude
  ```
- **Persistent:** set `ANTHROPIC_BASE_URL` and `ANTHROPIC_MODEL` in the `env`
  block of `~/.claude/settings.json`. (`claude` then only works while the proxy
  is running.)

Inside `claude`, run `/effort` and pick `xhigh` (**not** `max` — see the warning
above). The proxy logs each request, including the `effort` actually sent
upstream:

```
[proxy] POST /v1/messages  model=claude-opus-4-8 → glm-5.2  effort=xhigh  stream=true  fmt=anthropic  upstream=https://api.z.ai/api/anthropic
[proxy]   ← 200  812ms  ct=text/event-stream
```

## Request-body adaptation

Before forwarding a `/v1/messages` request, the proxy normalizes the Anthropic
body for the target upstream (in `rewriteBody`). The same normalized body feeds
both the Anthropic passthrough and the OpenAI bridge, so `reasoning_effort` is
honored either way.

| # | adaptation | why |
|---|------------|-----|
| — | `thinking.type: adaptive → enabled` | z.ai only accepts `enabled` / `disabled` |
| — | map `output_config.effort` → `reasoning_effort` (`max`/`xhigh → max`, `high`/`medium`/`low → high`, `minimal`/`none → none`) | double insurance in case `output_config` is ignored |
| — | MiMo upstreams: force `reasoning_effort = high` | MiMo doesn't accept GLM's `max` / `none` values |
| — | SiliconFlow upstreams: force `thinking.budget_tokens = 32768` and enable thinking | caps the thinking budget at SiliconFlow's documented max |
| — | strip `context_management` | Claude-Code-specific; upstream doesn't recognize it |
| — | clear `metadata.user_id` | device fingerprint / session id is pointless to send upstream and leaks privacy |
| — | recursively strip `cache_control` (messages / system / tools) | z.ai returns `cache_read_input_tokens = 0`; the marker is dead weight |
| — | clamp `max_tokens` to the target model's cap (GLM family table) | avoid over-large requests being rejected |
| — | strip Anthropic-specific `system` blocks (`x-anthropic-billing-header:`, `You are a Claude agent, built on Anthropic`) | Anthropic-only; meaningless to third-party upstreams |
| — | tag the last `tools` entry with `cache_control` (Anthropic-format pairs only) | triggers the upstream's context caching |

`PROXY_DUMP=1` writes each rewritten request body to `~/.claude-proxy/dumps/`
(next to `proxy.log`, never inside the project directory) so you can verify
the adaptation took effect.

## Files

| path                     | purpose                                            |
|--------------------------|----------------------------------------------------|
| `bin/claude-proxy.js`    | CLI entry — subcommand dispatch                    |
| `lib/server.js`          | the proxy server: routing, body adaptation, modelUsage injection |
| `lib/openai-bridge.js`   | Anthropic ↔ OpenAI format bridge (request / response / streaming SSE) |
| `lib/config.js`          | config find / edit / import / show (masked)        |
| `lib/daemon.js`          | background process management (pid + log)          |
| `lib/claude.js`          | start proxy + launch `claude` through it           |
| `lib/util.js`            | port cleanup / health probe / readiness wait       |
| `.env.example`           | documented template (bundled with the package)     |
| `~/.claude-proxy/.env`   | real config (yours, gitignored, never packaged)    |

## Notes / caveats

- **`xhigh` is required; `max` is broken in the VS Code extension.** The VS Code
  extension (≥2.1.187) validates `effortLevel` against
  `["low","medium","high","xhigh"]` — `max` is not in the enum and is silently
  coerced to `undefined` (→ falls back to `high`). The CLI accepts `max`, but a
  `max` value works in the CLI yet breaks the VS Code extension. `xhigh` is
  accepted by both and is the highest tier the VS Code extension supports. Avoid
  `/effort max` in the CLI — it rewrites `effortLevel` back to `max` and re-breaks
  the VS Code extension. This is why the warning above says to always use
  `xhigh`.
- The upstream must accept `output_config.effort` (Anthropic format) or
  `reasoning_effort` (OpenAI format). z.ai/SiliconFlow `glm-5.2` and 小米 MiMo
  all engage a thinking block for these — the param is honoured, not dropped.
- Only `POST /v1/messages` (excluding `/v1/messages/count_tokens`) gets its
  `model` rewritten. Other paths (`/v1/models`, …) are forwarded unchanged.
- `/v1/messages/count_tokens` has no OpenAI equivalent. For `FORMAT=openai`
  pairs the proxy returns a rough local estimate (`body length / 4`) so Claude
  Code's context display keeps working without hitting upstream; for
  `FORMAT=anthropic` pairs it is forwarded to the upstream as-is.
- **Unknown models are rejected with HTTP 400, not silently rewritten.** The
  incoming `model` must match a configured `SPOOF_MODEL` or `TARGET_MODEL`;
  otherwise the proxy returns an error instead of falling back to a default
  pair.
- `package.json` `files` excludes `.env`; real keys are never packaged into the
  global install. Config stays at `~/.claude-proxy/.env`.
- Effort unlock only defeats the **client-side** effort gate. It does not change
  what the model actually does with the effort parameter — that is up to the
  upstream.

## Versioning

This project follows [Semantic Versioning](https://semver.org/). The current
version lives in [VERSION](VERSION); all changes are recorded in
[CHANGELOG.md](CHANGELOG.md).

## Development

This directory (`claude-proxy/`) is the **development workspace** — the source
you edit and push to git. End users do **not** keep it; they
`npm install -g claude-proxy@<version>` a published build. The flow is:
edit here → test → bump version → publish → install.

```bash
git clone <repo> && cd claude-proxy
node --check lib/server.js lib/openai-bridge.js   # syntax check after edits
claude-proxy start                                 # run from source (foreground)
```

### Cutting a release

1. Bump `VERSION` and `package.json` `version` (SemVer: patch / minor / major).
2. Add a `## [X.Y.Z] - YYYY-MM-DD` entry at the top of `CHANGELOG.md`.
3. `git commit -a -m "release vX.Y.Z"` then `git tag vX.Y.Z`.
4. `npm publish` (remove `"private": true` in `package.json` first).
5. Users install with `npm install -g claude-proxy@X.Y.Z`.
