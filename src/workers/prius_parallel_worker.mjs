import { parentPort } from "node:worker_threads";
import fs from "node:fs";
import zlib from "node:zlib";
import crypto from "node:crypto";

const FILE_WRAPPER_HEADER_SIZE = 0x20;
const FILETIME = 0x01ca8b14a4e00000n;

function buildFileWrapper(rawData, compressLevel) {
  const compressed = zlib.deflateSync(rawData, { level: compressLevel });
  const header = Buffer.alloc(FILE_WRAPPER_HEADER_SIZE);
  header.writeUInt32LE(1, 0);
  header.writeUInt32LE(rawData.length >>> 0, 4);
  header.writeBigUInt64LE(FILETIME, 8);
  header.writeBigUInt64LE(FILETIME, 16);
  header.writeBigUInt64LE(FILETIME, 24);
  return Buffer.concat([header, compressed]);
}

parentPort.on("message", (task) => {
  try {
    const raw = fs.readFileSync(task.filePath);
    const wrapped = buildFileWrapper(raw, task.compressLevel);
    const rawSha1 = task.includeSha1 ? crypto.createHash("sha1").update(raw).digest() : Buffer.alloc(0);

    // Convert to plain Uint8Array so ArrayBuffer transfer is always supported.
    const wrappedView = Uint8Array.from(wrapped);
    const rawSha1View = rawSha1.length > 0 ? Uint8Array.from(rawSha1) : new Uint8Array(0);

    parentPort.postMessage(
      {
        type: "result",
        index: task.index,
        wrapped: wrappedView,
        rawSize: raw.length,
        rawSha1: rawSha1View
      },
      [wrappedView.buffer, rawSha1View.buffer]
    );
  } catch (err) {
    const msg = err && err.stack ? String(err.stack) : String(err);
    parentPort.postMessage({
      type: "error",
      index: task.index,
      error: msg
    });
  }
});
