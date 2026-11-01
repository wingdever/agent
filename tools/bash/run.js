"use strict";
const { exec } = require("child_process");

// 直接执行 shell 命令；授权即代表用户确认风险（由 approval 闸门保护）
module.exports = {
  async run({ command } = {}) {
    if (typeof command !== "string" || !command.trim()) return { error: "command 必须为非空字符串" };
    return await new Promise((resolve) => {
      exec(command, { maxBuffer: 1024 * 1024 * 20, timeout: 120000 }, (err, stdout, stderr) => {
        resolve({
          stdout: stdout || "",
          stderr: stderr || "",
          exitCode: err && err.code != null ? err.code : 0,
          error: err ? err.message : null,
        });
      });
    });
  },
};
