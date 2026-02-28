import { Worker } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { normalizeJobs } from "./prius_runtime.js";

const FILE_WRAPPER_HEADER_SIZE = 0x20;
const FILETIME = 0x01ca8b14a4e00000n;

export interface CompressedFile {
  index: number;
  wrapped: Buffer;
  rawSize: number;
  rawSha1: Buffer;
}

interface CompressTask {
  index: number;
  filePath: string;
  compressLevel: number;
  includeSha1: boolean;
}

interface WorkerResultMessage {
  type: "result";
  index: number;
  wrapped: Uint8Array;
  rawSize: number;
  rawSha1: Uint8Array;
}

interface WorkerErrorMessage {
  type: "error";
  index: number;
  error: string;
}

type WorkerMessage = WorkerResultMessage | WorkerErrorMessage;

type PkgProcess = NodeJS.Process & { pkg?: unknown };

function bufferFromView(view: Uint8Array): Buffer {
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}

function buildFileWrapper(rawData: Buffer, compressLevel: number): Buffer {
  const compressed = zlib.deflateSync(rawData, { level: compressLevel });
  const header = Buffer.alloc(FILE_WRAPPER_HEADER_SIZE);
  header.writeUInt32LE(1, 0);
  header.writeUInt32LE(rawData.length >>> 0, 4);
  header.writeBigUInt64LE(FILETIME, 8);
  header.writeBigUInt64LE(FILETIME, 16);
  header.writeBigUInt64LE(FILETIME, 24);
  return Buffer.concat([header, compressed]);
}

function compressSingle(filePath: string, compressLevel: number, includeSha1: boolean): CompressedFile {
  const raw = fs.readFileSync(filePath);
  const wrapped = buildFileWrapper(raw, compressLevel);
  const rawSha1 = includeSha1 ? crypto.createHash("sha1").update(raw).digest() : Buffer.alloc(0);
  return { index: 0, wrapped, rawSize: raw.length, rawSha1 };
}

function resolveWorkerScriptPath(): string | null {
  const isPackagedExe = Boolean((process as PkgProcess).pkg);
  if (isPackagedExe) {
    return null;
  }

  const candidates: string[] = [];
  try {
    candidates.push(fileURLToPath(new URL("../workers/prius_parallel_worker.mjs", import.meta.url)));
  } catch {
    // Ignore and try argv/cwd fallbacks below.
  }
  if (process.argv[1]) {
    const baseDir = path.dirname(process.argv[1]);
    candidates.push(path.resolve(baseDir, "..", "workers", "prius_parallel_worker.mjs"));
    candidates.push(path.resolve(baseDir, "prius_parallel_worker.mjs"));
  }
  candidates.push(path.resolve(process.cwd(), "src", "workers", "prius_parallel_worker.mjs"));
  candidates.push(path.resolve(process.cwd(), "prius_parallel_worker.mjs"));

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }
  return null;
}

const WORKER_SCRIPT_PATH = resolveWorkerScriptPath();
let warnedNoWorker = false;

function canUseWorkerThreads(): boolean {
  return WORKER_SCRIPT_PATH !== null;
}

function createCompressionWorker(): Worker {
  if (!WORKER_SCRIPT_PATH) {
    throw new Error("Compression worker script unavailable");
  }
  return new Worker(WORKER_SCRIPT_PATH);
}

function warnWorkerUnavailable(requestedWorkers: number): void {
  if (warnedNoWorker || requestedWorkers <= 1 || canUseWorkerThreads()) {
    return;
  }
  warnedNoWorker = true;
  console.warn("Warning: worker script unavailable in this runtime; falling back to single-thread compression.");
}

export async function compressFilesBatch(
  filePaths: string[],
  compressLevel: number,
  jobs: number,
  includeSha1 = false
): Promise<CompressedFile[]> {
  if (filePaths.length === 0) {
    return [];
  }

  const workerCount = normalizeJobs(jobs, filePaths.length);
  if (workerCount <= 1 || !canUseWorkerThreads()) {
    warnWorkerUnavailable(workerCount);
    const out: CompressedFile[] = [];
    for (let i = 0; i < filePaths.length; i += 1) {
      const single = compressSingle(filePaths[i], compressLevel, includeSha1);
      out.push({ ...single, index: i });
    }
    return out;
  }

  const tasks: CompressTask[] = filePaths.map((filePath, index) => ({
    index,
    filePath,
    compressLevel,
    includeSha1
  }));
  const results: Array<CompressedFile | undefined> = new Array(tasks.length);
  const workers: Worker[] = [];
  let settled = false;
  let completed = 0;
  let nextTask = 0;

  return new Promise<CompressedFile[]>((resolve, reject) => {
    const terminateAll = async (): Promise<void> => {
      await Promise.all(workers.map(async (w) => w.terminate()));
    };

    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      void terminateAll().finally(() => reject(error instanceof Error ? error : new Error(String(error))));
    };

    const maybeComplete = (): void => {
      if (settled || completed !== tasks.length) {
        return;
      }
      settled = true;
      void terminateAll().finally(() => {
        resolve(results as CompressedFile[]);
      });
    };

    const dispatch = (worker: Worker): void => {
      if (settled || nextTask >= tasks.length) {
        return;
      }
      worker.postMessage(tasks[nextTask]);
      nextTask += 1;
    };

    const onMessage = (worker: Worker, rawMsg: WorkerMessage): void => {
      if (rawMsg.type === "error") {
        fail(new Error(`Compression worker task ${rawMsg.index} failed: ${rawMsg.error}`));
        return;
      }
      const msg = rawMsg as WorkerResultMessage;
      results[msg.index] = {
        index: msg.index,
        wrapped: bufferFromView(msg.wrapped),
        rawSize: msg.rawSize,
        rawSha1: bufferFromView(msg.rawSha1)
      };
      completed += 1;
      dispatch(worker);
      maybeComplete();
    };

    for (let i = 0; i < workerCount; i += 1) {
      const worker = createCompressionWorker();
      workers.push(worker);
      worker.on("message", (msg: WorkerMessage) => onMessage(worker, msg));
      worker.on("error", (err) => fail(err));
      worker.on("exit", (code) => {
        if (!settled && code !== 0 && completed < tasks.length) {
          fail(new Error(`Compression worker exited with code ${code}`));
        }
      });
      dispatch(worker);
    }
  });
}

export async function* compressFilesStream(
  filePaths: string[],
  compressLevel: number,
  jobs: number,
  includeSha1 = false
): AsyncGenerator<CompressedFile> {
  if (filePaths.length === 0) {
    return;
  }

  const workerCount = normalizeJobs(jobs, filePaths.length);
  if (workerCount <= 1 || !canUseWorkerThreads()) {
    warnWorkerUnavailable(workerCount);
    for (let i = 0; i < filePaths.length; i += 1) {
      const single = compressSingle(filePaths[i], compressLevel, includeSha1);
      yield { ...single, index: i };
    }
    return;
  }

  const tasks: CompressTask[] = filePaths.map((filePath, index) => ({
    index,
    filePath,
    compressLevel,
    includeSha1
  }));
  const ready: CompressedFile[] = [];
  const workers: Worker[] = [];
  const waiters: Array<() => void> = [];
  let nextTask = 0;
  let yielded = 0;
  let completed = 0;
  let failed: Error | null = null;

  const notify = (): void => {
    while (waiters.length > 0) {
      const w = waiters.shift();
      if (w) {
        w();
      }
    }
  };

  const waitForEvent = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      waiters.push(resolve);
    });
  };

  const dispatch = (worker: Worker): void => {
    if (failed || nextTask >= tasks.length) {
      return;
    }
    worker.postMessage(tasks[nextTask]);
    nextTask += 1;
  };

  const fail = (err: unknown): void => {
    if (!failed) {
      failed = err instanceof Error ? err : new Error(String(err));
      notify();
    }
  };

  const onMessage = (worker: Worker, rawMsg: WorkerMessage): void => {
    if (rawMsg.type === "error") {
      fail(new Error(`Compression worker task ${rawMsg.index} failed: ${rawMsg.error}`));
      return;
    }
    const msg = rawMsg as WorkerResultMessage;
    ready.push({
      index: msg.index,
      wrapped: bufferFromView(msg.wrapped),
      rawSize: msg.rawSize,
      rawSha1: bufferFromView(msg.rawSha1)
    });
    completed += 1;
    dispatch(worker);
    notify();
  };

  for (let i = 0; i < workerCount; i += 1) {
    const worker = createCompressionWorker();
    workers.push(worker);
    worker.on("message", (msg: WorkerMessage) => onMessage(worker, msg));
    worker.on("error", (err) => fail(err));
    worker.on("exit", (code) => {
      if (!failed && code !== 0 && completed < tasks.length) {
        fail(new Error(`Compression worker exited with code ${code}`));
      }
    });
    dispatch(worker);
  }

  try {
    while (yielded < tasks.length) {
      while (ready.length > 0) {
        const item = ready.shift()!;
        yield item;
        yielded += 1;
      }
      if (failed) {
        throw failed;
      }
      if (yielded >= tasks.length) {
        break;
      }
      await waitForEvent();
    }
  } finally {
    await Promise.all(workers.map(async (w) => w.terminate()));
  }
}
