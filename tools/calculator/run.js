"use strict";
module.exports = {
  async run({ expression } = {}) {
    if (typeof expression !== "string" || !/^[0-9+\-*/().\s]+$/.test(expression)) throw new Error("invalid expression");
    return { result: Function('"use strict";return (' + expression + ");")() };
  },
};
