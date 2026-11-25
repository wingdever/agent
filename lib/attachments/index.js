"use strict";

// Durable image attachments: content-addressed files under data/attachments.
// The model-facing tool result carries a short reference; the original bytes
// stay available for later turns and for UI preview.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { PROJECT_ROOT } from "./../paths/index.js";

const ATTACHMENTS_ROOT = path.join(PROJECT_ROOT, "data", "attachments");

const EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

function extensionFor(mediaType) {
  return EXTENSIONS[mediaType] || "bin";
}

async function put({ bytes, mediaType, root = ATTACHMENTS_ROOT }) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error("attachment bytes must be non-empty");
  if (!EXTENSIONS[mediaType]) throw new Error("unsupported attachment media type: " + mediaType);
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  const dir = root;
  const file = path.join(dir, sha + "." + extensionFor(mediaType));
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(file, bytes, { flag: "wx", mode: 0o444 });
  } catch (error) {
    if (!error || error.code !== "EEXIST") {
      throw new Error("cannot store attachment: " + (error.message || String(error)));
    }
  }
  return {
    id: "att_" + sha.slice(0, 24),
    path: file,
    mediaType,
    bytes: bytes.length,
    sha256: sha,
  };
}

async function read(attachmentPath) {
  return fs.promises.readFile(attachmentPath);
}

export { ATTACHMENTS_ROOT, EXTENSIONS, extensionFor, put, read };
export default { ATTACHMENTS_ROOT, EXTENSIONS, extensionFor, put, read };
