"use strict";

// A headless xterm instance is the authoritative screen model for an
// interactive terminal. PTY output is parsed exactly once, in order; the
// rendered active buffer is then reused for tool reads and for reconnecting
// browser panels. Keeping this here (instead of in the UI) means the agent and
// the user always observe the same screen, including full-screen TUI apps.

import headless from "@xterm/headless";
import serialize from "@xterm/addon-serialize";

const { Terminal } = headless;
const { SerializeAddon } = serialize;

const SCREEN_SCROLLBACK = 2000;

class TerminalScreen {
  constructor({ cols = 120, rows = 30, scrollback = SCREEN_SCROLLBACK } = {}) {
    this.term = new Terminal({
      cols,
      rows,
      scrollback,
      allowProposedApi: true,
      convertEol: false,
    });
    this.serializeAddon = new SerializeAddon();
    this.term.loadAddon(this.serializeAddon);
    this.lastSeq = 0;
    this._chain = Promise.resolve();
    this._disposed = false;
  }

  write(data, seq) {
    if (this._disposed || data == null || data === "") return this._chain;
    const text = String(data);
    this._chain = this._chain
      .then(() => new Promise((resolve) => {
        if (this._disposed) {
          resolve();
          return;
        }
        try {
          this.term.write(text, () => {
            if (Number.isFinite(seq)) this.lastSeq = seq;
            resolve();
          });
        } catch (_) {
          resolve();
        }
      }))
      .catch(() => {});
    return this._chain;
  }

  flush() {
    // A disposed terminal can leave a queued write callback pending. Bound the
    // wait so a closing panel cannot hold a WebSocket snapshot forever.
    return Promise.race([
      this._chain,
      new Promise((resolve) => setTimeout(resolve, 250)),
    ]);
  }

  async resize(cols, rows) {
    await this.flush();
    if (this._disposed) return;
    const nextCols = Math.max(2, Math.floor(cols));
    const nextRows = Math.max(2, Math.floor(rows));
    if (nextCols === this.term.cols && nextRows === this.term.rows) return;
    this.term.resize(nextCols, nextRows);
  }

  async snapshot() {
    await this.flush();
    if (this._disposed) return { data: "", seq: this.lastSeq };
    let data = "";
    try {
      data = this.serializeAddon.serialize({ scrollback: SCREEN_SCROLLBACK });
    } catch (_) {
      data = this._plainScreen();
    }
    return { data, seq: this.lastSeq };
  }

  async readLines(limit) {
    await this.flush();
    if (this._disposed) {
      return { text: "(no output)", totalLines: 0, fromLine: 0, toLine: 0 };
    }
    const lines = this._plainLines();
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    if (!lines.length) {
      return {
        text: "(no output)",
        totalLines: 0,
        fromLine: 0,
        toLine: 0,
      };
    }
    const count = Math.max(1, Math.min(SCREEN_SCROLLBACK, Math.floor(limit) || 500));
    const start = Math.max(0, lines.length - count);
    const selected = lines.slice(start);
    return {
      text: selected.join("\n"),
      totalLines: lines.length,
      fromLine: start + 1,
      toLine: lines.length,
    };
  }

  _plainLines() {
    if (this._disposed) return [];
    const buffer = this.term.buffer.active;
    const lines = [];
    for (let i = 0; i < buffer.length; i += 1) {
      lines.push(buffer.getLine(i)?.translateToString(true) || "");
    }
    return lines;
  }

  _plainScreen() {
    const lines = this._plainLines();
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.join("\r\n");
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    try { this.term.dispose(); } catch (_) {}
  }
}

const __exports = { TerminalScreen };
export { TerminalScreen };
export default __exports;
