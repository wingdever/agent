"use strict";

// read_image: return the image itself, not a text transcription. The tool
// validates the file by magic bytes, stores a durable content-addressed copy,
// and emits an OpenAI-compatible image_url content part alongside the text
// envelope. Dimensions are parsed without adding an image dependency.

import fs from "fs";
import {
  resolveFilePath,
  statFile,
} from "./../lib/fs-edit.js";
import { put } from "./../../lib/attachments/index.js";
import { record } from "./../../lib/fs-observe/index.js";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function readUInt24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function detectImage(buffer) {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mediaType: "image/png", width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mediaType: "image/jpeg", ...jpegSize(buffer) };
  }
  if (buffer.length >= 10 && (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a")) {
    return { mediaType: "image/gif", width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return { mediaType: "image/webp", ...webpSize(buffer) };
  }
  throw new Error("unsupported image format; expected PNG, JPEG, WebP, or GIF");
}

function jpegSize(buffer) {
  let offset = 2;
  while (offset + 4 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    let markerOffset = offset;
    while (markerOffset < buffer.length && buffer[markerOffset] === 0xff) markerOffset += 1;
    const marker = buffer[markerOffset];
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset = markerOffset + 1;
      continue;
    }
    if (marker === 0xda) break; // start of scan; no SOF found
    if (markerOffset + 3 >= buffer.length) break;
    const length = buffer.readUInt16BE(markerOffset + 1);
    if (length < 2) break;
    const isSof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
    if (isSof && markerOffset + 8 < buffer.length) {
      return { width: buffer.readUInt16BE(markerOffset + 6), height: buffer.readUInt16BE(markerOffset + 4) };
    }
    offset = markerOffset + 1 + length;
  }
  return { width: null, height: null };
}

function webpSize(buffer) {
  const chunk = buffer.subarray(12, 16).toString("ascii");
  if (chunk === "VP8X" && buffer.length >= 30) {
    return {
      width: 1 + readUInt24LE(buffer, 24),
      height: 1 + readUInt24LE(buffer, 27),
    };
  }
  if (chunk === "VP8L" && buffer.length >= 25 && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    };
  }
  if (chunk === "VP8 " && buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  return { width: null, height: null };
}

function formatSize(width, height) {
  return width && height ? width + "x" + height : "unknown";
}

export default {
  async run(args = {}, exec = {}) {
    const displayPath = resolveFilePath(args.file_path, exec.cwd, "file_path");
    const info = await statFile(displayPath, "read");
    if (!info.isFile()) throw new Error('cannot read "' + displayPath + '": not a regular file');
    if (info.size > MAX_IMAGE_BYTES) {
      throw new Error('cannot read "' + displayPath + '": image is larger than ' + MAX_IMAGE_BYTES + " bytes");
    }
    let bytes;
    try {
      bytes = await fs.promises.readFile(displayPath);
    } catch (error) {
      throw new Error('cannot read "' + displayPath + '": ' + (error.message || String(error)));
    }
    const detected = detectImage(bytes);
    const attachment = await put({
      bytes,
      mediaType: detected.mediaType,
      root: exec.attachmentRoot,
    });
    record(exec.sessionId, displayPath, info);

    const dimensions = formatSize(detected.width, detected.height);
    const text =
      "<path>" + displayPath + "</path>\n" +
      "<type>image</type>\n" +
      "<media_type>" + detected.mediaType + "</media_type>\n" +
      "<dimensions>" + dimensions + "</dimensions>\n" +
      "<bytes>" + bytes.length + "</bytes>\n" +
      "<attachment_id>" + attachment.id + "</attachment_id>\n" +
      "<attachment_path>" + attachment.path + "</attachment_path>\n" +
      "<content>Image attached. Inspect the image directly.</content>";

    return {
      text,
      content: [{
        type: "image_url",
        image_url: {
          url: "data:" + detected.mediaType + ";base64," + bytes.toString("base64"),
          detail: "auto",
        },
      }],
      meta: {
        path: displayPath,
        mediaType: detected.mediaType,
        width: detected.width,
        height: detected.height,
        bytes: bytes.length,
        attachmentId: attachment.id,
        attachmentPath: attachment.path,
      },
    };
  },
};
