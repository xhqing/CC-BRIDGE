# claude-proxy — Claude Code effort-unlock proxy

> 中文文档：[README.zh-CN.md](README.zh-CN.md)

A local transparent proxy that lets Claude Code use **`/effort max`** (and `xhigh`)
with third-party models served via Anthropic-compatible **or** OpenAI-compatible
gateways (e.g. z.ai · `glm-5.2`, SiliconFlow, 小米 MiMo). Supports multiple
upstream/model pairs at once.

Install it once and start it from **any directory** with a single command:
`claude-proxy`.

> ⚠️ **Always use `/effort xhigh`, never `/effort max`.** In the current VS Code
> extension, `max` is **not usable** — it's absent from the extension's
> `effortLevel` enum and is silently coerced back to `high`, so glm-5.2 never
> actually runs at `max`. To keep glm-5.2's thinking tier pinned at the maximum,
> use `/effort xhigh` uniformly in **both** the CLI and the VS Code extension.
> `xhigh` is the highest tier the VS Code extension supports and is accepted by
> both. (Details in [Notes / caveats](#notes--caveats).)

## Why

Claude Code gates `max`/`xhigh` behind a **client-side** check: the active model
ID must be on a Claude whitelist (`claude-opus-4-8`, …) **or** the provider must be
first-party / Bedrock / Foundry. A third-party gateway fails both, so
`/effort max` silently falls back to `high`.

This proxy breaks that check by feeding Claude Code a spoofed whitelisted model
ID while rewriting the actual request back to the real model before it hits the
upstream. The upstream already speaks the native Anthropic API, so the proxy
only rewrites `body.model` — message shape, tool calls, SSE events, and
`output_config.effort` all pass through verbatim.

```
Claude Code  ──model=claude-opus-4-8, effort=max──▶  proxy (127.0.0.1:8787)
                                                       │ rewrite body.model → glm-5.2
                                                       ▼
                              upstream (z.ai / SiliconFlow / MiMo …)  ◀── 200 + thinking/SSE
```

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
SPOOF_MODEL=claude-haiku-4-5   # whitelisted ID Claude Code sees (unlocks max)
FORMAT=openai                  # anthropic ↔ openai (/v1/chat/completions)
CONTEXT_WINDOW=1000000         # injected into the usage display
PROXY_PORT=8787
PROXY_LOG=1                    # 0 to silence per-request logging

# --- Pair #2: Anthropic-native gateway (numeric suffix _2, _3, …) ---
# API_BASE_2=https://api.z.ai/api/anthropic
# API_KEY_2="your_real_key"
# SPOOF_MODEL_2=claude-opus-4-8
# TARGET_MODEL_2=glm-5.2
# FORMAT_2=anthropic            # native /v1/messages passthrough (default)
```

> `SPOOF_MODEL` must be a model Claude Code's whitelist accepts for the tier you
> want: `claude-opus-4-8` / `claude-opus-4-7` unlock both `max` and `xhigh`.
> The upstream never sees this value — the proxy rewrites it to `TARGET_MODEL`.
>
> **Multiple pairs:** every `SPOOF_MODEL_n` / `TARGET_MODEL_n` adds a route.
> Point Claude Code at whichever spoof ID you want (e.g. `ANTHROPIC_MODEL=claude-opus-4-8`)
> and the proxy routes to that pair's upstream, translating formats when needed.
> An unknown model (no matching spoof/target) is **rejected with HTTP 400** — it is
> never silently rewritten to a default.

## Usage

```bash
claude-proxy start           # start in foreground (Ctrl-C to stop)
claude-proxy daemon          # start in background (detached)
claude-proxy claude [args]   # start proxy + launch claude pointed at it
claude-proxy stop            # stop the background service
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
[proxy] POST /v1/messages  model=claude-opus-4-8 → glm-5.2  effort=xhigh  stream=true
[proxy]   ← 200  812ms  ct=text/event-stream
```

## Files

| path                     | purpose                                            |
|--------------------------|----------------------------------------------------|
| `bin/claude-proxy.js`    | CLI entry — subcommand dispatch                    |
| `lib/server.js`          | the proxy server (transparent pass-through)        |
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
  the VS Code extension. This is why the warning at the top says to always use
  `xhigh`.
- The upstream must accept `output_config.effort` (Anthropic format) or
  `reasoning_effort` (OpenAI format). z.ai/SiliconFlow `glm-5.2` and 小米 MiMo
  all engage a thinking block for these — the param is honoured, not dropped.
- Only `POST /v1/messages` gets its `model` rewritten. Every other path
  (`/v1/models`, `/v1/messages/count_tokens`, …) is forwarded unchanged.
- **Unknown models are rejected with HTTP 400, not silently rewritten.** The
  incoming `model` must match a configured `SPOOF_MODEL` or `TARGET_MODEL`;
  otherwise the proxy returns an error instead of falling back to a default
  pair — so you always know which model you're actually hitting.
- `package.json` `files` excludes `.env`; real keys are never packaged into the
  global install. Config stays at `~/.claude-proxy/.env`.
- This only affects the **client-side effort gate**. It does not change what the
  model actually does with the effort parameter — that is up to the upstream.

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
