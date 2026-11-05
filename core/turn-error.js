"use strict";

// 一个 turn（一次 chat 调用）的预期内终止原因。循环体内只负责抛 TurnError 或返回，
// 由 chat() 外层的 catch/finally 统一区分 reason 并落 [turn] 日志。
// 抽成独立模块，使引擎（core/loops/*）与 core/index.js 共用同一个类，
// 否则 instanceof 跨模块会失效。
class TurnError extends Error {
  constructor(reason, message) {
    super(message || reason);
    this.name = "TurnError";
    this.reason = reason;
  }
}

module.exports = { TurnError };
