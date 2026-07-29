'use strict';

// 上游注册表 + adapter 加载器。
// 每个上游（GLM / Kimi / Qwen …）在顶层 cc-<name>-bridge/ 目录下放一个 adapter.js，
// 实现统一接口（见 cc-glm-bridge/adapter.js）。新增上游时：在此注册表加一行，
// 并建对应的 cc-<name>-bridge/adapter.js。
//
// adapter 接口：
//   name             上游标识（目录名 cc-<name>-bridge、配置文件 <name>.env 均由它派生）
//   displayName      展示名（日志 / health 用）
//   defaultTarget    默认 TARGET_MODEL（配置未填时兜底）
//   defaultSpoof     默认 SPOOF_MODEL
//   defaultThinking  默认思考等级（max/high/none）；MODEL_THINKING 未列某模型、且未配
//                    MODEL_THINKING_DEFAULT 时用它兜底（GLM 默认 max）
//   modelMaxTokens   { modelId: maxOutputTokens } 表，用于钳 max_tokens
//   adaptRequestBody(obj, ctx)  改写 Anthropic 请求体（上游专属适配），ctx = { target }；
//                   内部按 ctx.target 查 this.modelThinking（运行时由 server 从 MODEL_THINKING
//                   注入）决定思考等级，this.thinkingDefault 为兜底

const REGISTRY = {
  glm: { dir: 'cc-glm-bridge', implemented: true },
  kimi: { dir: 'cc-kimi-bridge', implemented: false },
  qwen: { dir: 'cc-qwen-bridge', implemented: false },
};

const DEFAULT_UPSTREAM = 'glm';

function listUpstreams() {
  return Object.keys(REGISTRY);
}

function isKnown(name) {
  return Object.prototype.hasOwnProperty.call(REGISTRY, name);
}

function isImplemented(name) {
  const entry = REGISTRY[name];
  return !!entry && entry.implemented;
}

// 加载某上游的 adapter。未注册或未实现时抛错（错误信息提示如何扩展）。
function loadAdapter(name) {
  const entry = REGISTRY[name];
  if (!entry) {
    throw new Error(`unknown upstream '${name}'. Known upstreams: ${listUpstreams().join(', ')}.`);
  }
  if (!entry.implemented) {
    throw new Error(
      `upstream '${name}' is reserved but not implemented yet. ` +
      `Create ${entry.dir}/adapter.js to add it (see cc-glm-bridge/adapter.js for the interface).`,
    );
  }
  // adapter 在顶层 <dir>/adapter.js，本文件在 core/，故 ../<dir>/adapter。
  return require(`../${entry.dir}/adapter`);
}

module.exports = { REGISTRY, DEFAULT_UPSTREAM, listUpstreams, isKnown, isImplemented, loadAdapter };
