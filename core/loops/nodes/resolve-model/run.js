"use strict";

// 节点 resolve-model：解析生效的 stream / model / provider 凭据（baseUrl / apiKey）。
// 与 linear 的 settings.provider 解析一致；effort 由 ctx.effort 注入（chat 入口已设）。

const { readSettings, resolveProvider } = require("../../shared");

module.exports = async function run(input, ctx) {
  const st = readSettings();
  const effStream = ctx.stream !== undefined ? !!ctx.stream : (st.stream === true);
  let effModel = ctx.model || st.model || ctx.core.model;
  if (st.provider) {
    const p = resolveProvider(st.provider);
    if (p) {
      ctx.core.baseUrl = p.baseUrl;
      ctx.core.apiKey = p.apiKey;
      if (!effModel) effModel = p.model;
    }
  }
  ctx.effStream = effStream;
  ctx.effModel = effModel;
  return { output: { model: effModel, stream: effStream }, next: "assemble-system" };
};
