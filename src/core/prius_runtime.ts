import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function formatElapsed(ms: number): string {
  if (ms < 1000) {
    return `${ms.toFixed(1)}ms`;
  }
  const sec = ms / 1000;
  if (sec < 60) {
    return `${sec.toFixed(2)}s`;
  }
  const min = Math.floor(sec / 60);
  const secRem = sec - min * 60;
  if (min < 60) {
    return `${min}m ${secRem.toFixed(1)}s`;
  }
  const hr = Math.floor(min / 60);
  const minRem = min % 60;
  return `${hr}h ${minRem}m ${secRem.toFixed(0)}s`;
}

export function elapsedSince(startNs: bigint): string {
  const ms = Number(process.hrtime.bigint() - startNs) / 1_000_000;
  return formatElapsed(ms);
}

export function defaultJobs(): number {
  const cpus = os.cpus();
  if (!cpus || cpus.length === 0) {
    return 1;
  }
  return cpus.length;
}

export function normalizeJobs(jobs: number | undefined, maxValue: number): number {
  if (!Number.isFinite(maxValue) || maxValue <= 0) {
    return 1;
  }
  if (jobs === undefined || jobs === null || jobs <= 0) {
    return Math.max(1, Math.min(defaultJobs(), maxValue));
  }
  return Math.max(1, Math.min(Math.floor(jobs), maxValue));
}

export function isMainModule(metaUrl?: string): boolean {
  if (!process.argv[1]) {
    return false;
  }
  if (!metaUrl || !metaUrl.startsWith("file:")) {
    // Bundled CJS builds may not expose import.meta.url.
    return true;
  }
  const selfPath = path.resolve(fileURLToPath(metaUrl));
  const entryPath = path.resolve(process.argv[1]);
  return selfPath === entryPath;
}
