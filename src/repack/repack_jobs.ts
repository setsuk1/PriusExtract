import { compressFilesBatch } from "../core/prius_parallel_compress.js";
import { defaultJobs, formatElapsed, normalizeJobs } from "../core/prius_runtime.js";

export function suggestJobsForCompression(compressLevel: number): number {
  const cores = defaultJobs();
  if (compressLevel <= 1) {
    return Math.max(1, cores);
  }
  return Math.max(1, cores);
}

export async function autoTuneJobCount(
  validLocalPaths: string[],
  compressLevel: number,
  initialJobs: number
): Promise<number> {
  if (validLocalPaths.length < 256) {
    return initialJobs;
  }

  const cores = defaultJobs();
  const sampleSize = Math.min(128, validLocalPaths.length);
  const samplePaths = validLocalPaths.slice(0, sampleSize);
  const rawCandidates = [
    1,
    Math.max(2, Math.floor(cores / 2)),
    Math.max(1, cores),
    Math.max(1, cores * 2),
    initialJobs
  ];
  const candidates = [...new Set(rawCandidates.map((n) => normalizeJobs(n, validLocalPaths.length)))].sort((a, b) => a - b);
  if (candidates.length <= 1) {
    return initialJobs;
  }

  console.log(`  auto-tuning jobs on ${sampleSize.toLocaleString()} sample files...`);
  let bestJobs = initialJobs;
  let bestMs = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const t0 = process.hrtime.bigint();
    await compressFilesBatch(samplePaths, compressLevel, candidate, false);
    const ms = Number(process.hrtime.bigint() - t0) / 1_000_000;
    console.log(`    jobs=${candidate}: ${formatElapsed(ms)}`);
    if (ms < bestMs) {
      bestMs = ms;
      bestJobs = candidate;
    }
  }

  console.log(`  auto-tune selected jobs=${bestJobs}`);
  return bestJobs;
}
