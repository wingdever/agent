"use strict";

// Managed DSH_* variables for shell tools. The prefix matches DSH so prompts
// and habits transfer; ambient DSH_* values are discarded first, exactly like
// DSH's shell-env registry.

function shellEnv(sessionId) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("DSH_")) delete env[key];
  }
  if (sessionId != null && sessionId !== "") env.DSH_SESSION_ID = String(sessionId);
  if (process.env.DSH_WEB_URL) env.DSH_WEB_URL = process.env.DSH_WEB_URL;
  if (process.env.DSH_HOME) env.DSH_HOME = process.env.DSH_HOME;
  return env;
}

module.exports = { shellEnv };
