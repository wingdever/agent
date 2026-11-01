"use strict";
module.exports = {
  async run({ expression } = {}) {
    if (typeof expression !== "string" || !/^[0-9+\-*/().\s]+$/.test(expression)) throw new Error("非法表达式");
    return { result: Function('"use strict";return (' + expression + ");")() };
  },
};
