"use strict";

// Stream rendering shared by bash providers: keep the tail the model can see,
// and spill the complete stream so truncated output remains recoverable.

import { writeSpill, tailByBytes } from "../../lib/tool-result/index.js";

export const MAX_STREAM_BYTES = 64 * 1024;

export function renderStream(text, callId, name) {
  const kept = tailByBytes(text, MAX_STREAM_BYTES);
  if (kept === text) return { text: kept, truncated: false, spillPath: null };
  const spillPath = writeSpill(callId, name, text);
  return {
    text: kept + "\n[output truncated; full output: " + (spillPath || "(unavailable)") + "]",
    truncated: true,
    spillPath,
  };
}

export default { MAX_STREAM_BYTES, renderStream };
