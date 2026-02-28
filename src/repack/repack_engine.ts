import fs from "node:fs";
import path from "node:path";
import { DAT_BLOCK_SIZE, META_SIZE, PriusArchive, packMetaRecord } from "../core/prius_archive.js";
import { compressFilesStream } from "../core/prius_parallel_compress.js";
import { elapsedSince, normalizeJobs } from "../core/prius_runtime.js";
import { statFileSizes, walkFilesSorted } from "../core/fs_walk.js";
import { writeIdx } from "./idx_writer.js";
import { autoTuneJobCount, suggestJobsForCompression } from "./repack_jobs.js";
import { StringTableBuilder } from "./string_table.js";
import { PatriciaTrieBuilder } from "./patricia_trie.js";

export interface RepackStats {
  files: number;
  skipped: number;
  deduped: number;
  rawSize: number;
  datSize: number;
  idxSize: number;
  verified?: number;
  verifyErrors?: number;
}

export function normalizeArchivePath(p: string): string {
  return p.replaceAll("/", "\\").toLowerCase();
}

export async function repack(
  inDir: string,
  outIdx: string,
  outDat: string,
  fileList: string[] | null = null,
  compressLevel = 6,
  verify = false,
  progressInterval = 5000,
  jobs: number | null = null,
  autoTuneJobs = false,
  sizeSchedule = false
): Promise<RepackStats> {
  const totalStart = process.hrtime.bigint();
  const root = path.resolve(inDir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Input directory not found: ${inDir}`);
  }

  interface CandidatePath {
    srcArcPath: string;
    localPath: string;
  }

  const candidates: CandidatePath[] = [];
  if (fileList) {
    for (const srcArcPath of fileList) {
      candidates.push({
        srcArcPath,
        localPath: path.join(root, srcArcPath.replaceAll("\\", path.sep))
      });
    }
  } else {
    for (const abs of walkFilesSorted(root)) {
      const rel = path.relative(root, abs);
      candidates.push({
        srcArcPath: rel.replaceAll(path.sep, "\\"),
        localPath: abs
      });
    }
  }

  if (candidates.length === 0) {
    throw new Error("No files to repack");
  }

  console.log(`Repacking ${candidates.length.toLocaleString()} files from ${inDir}`);
  console.log(`  compress_level=${compressLevel}`);

  console.log("\nPhase 1: Building string table...");
  const phase1Start = process.hrtime.bigint();
  const stb = new StringTableBuilder();
  const keys: Buffer[] = [];
  const stringIndices: number[] = [];
  const metaIndices: number[] = [];
  const validPaths: string[] = [];
  const validLocalPaths: string[] = [];
  const seenPaths = new Set<string>();
  let skipped = 0;
  let deduped = 0;
  const sourceIsWalkedFiles = fileList === null;
  let scanned = 0;

  for (const candidate of candidates) {
    const arcPath = normalizeArchivePath(candidate.srcArcPath);
    if (seenPaths.has(arcPath)) {
      deduped += 1;
      continue;
    }

    if (!sourceIsWalkedFiles) {
      try {
        if (!fs.statSync(candidate.localPath).isFile()) {
          skipped += 1;
          continue;
        }
      } catch {
        skipped += 1;
        continue;
      }
    }

    seenPaths.add(arcPath);

    const key = Buffer.from(arcPath, "utf8");
    const strIdx = stb.add(key, arcPath);

    keys.push(key);
    stringIndices.push(strIdx);
    metaIndices.push(validPaths.length);
    validPaths.push(arcPath);
    validLocalPaths.push(candidate.localPath);

    scanned += 1;
    if (scanned % progressInterval === 0) {
      console.log(`  indexed ${scanned.toLocaleString()} / ${candidates.length.toLocaleString()} ...`);
    }
  }

  const stringData = stb.build();
  console.log(`  Strings: ${stb.recordCount.toLocaleString()} records, ${stringData.length.toLocaleString()} bytes`);
  console.log(
    `  Valid files: ${validPaths.length.toLocaleString()}, skipped (not found): ${skipped.toLocaleString()}, deduped: ${deduped.toLocaleString()}`
  );
  console.log(`  Phase 1 elapsed: ${elapsedSince(phase1Start)}`);

  console.log("\nPhase 2: Building Patricia trie...");
  const phase2Start = process.hrtime.bigint();
  const trie = new PatriciaTrieBuilder();
  trie.buildFromKeys(keys, stringIndices, metaIndices);
  const dtData = trie.build();
  console.log(`  DT nodes: ${trie.nodeCount.toLocaleString()}, ${dtData.length.toLocaleString()} bytes`);
  console.log(`  Phase 2 elapsed: ${elapsedSince(phase2Start)}`);

  console.log(`\nPhase 3: Compressing and writing ${outDat}...`);
  const phase3Start = process.hrtime.bigint();
  let totalRawSize = 0;
  let currentBlock = 1;
  const fatEntries: number[] = [0];
  const startBlocks: number[] = new Array(validPaths.length);
  const wrappedSizes: number[] = new Array(validPaths.length);
  const requestedJobs = jobs ?? suggestJobsForCompression(compressLevel);
  let activeJobs = normalizeJobs(requestedJobs, validLocalPaths.length);
  if (jobs === null && autoTuneJobs) {
    activeJobs = await autoTuneJobCount(validLocalPaths, compressLevel, activeJobs);
  }
  const zeroPad = Buffer.alloc(DAT_BLOCK_SIZE);
  const writeThreshold = 8 * 1024 * 1024;
  if (jobs === null) {
    console.log(`  jobs=auto(${activeJobs})`);
  } else {
    console.log(`  jobs=${activeJobs}`);
  }
  let processed = 0;

  let scheduledPaths = validLocalPaths;
  let scheduledToOriginal: number[] | null = null;
  if (sizeSchedule && validLocalPaths.length > 1) {
    const scheduleStart = process.hrtime.bigint();
    const sizeScanConcurrency = normalizeJobs(
      jobs ?? suggestJobsForCompression(compressLevel),
      Math.max(1, validLocalPaths.length)
    );
    const sizes = await statFileSizes(validLocalPaths, sizeScanConcurrency);
    const sized: Array<{ path: string; originalIndex: number; size: number }> = [];
    for (let i = 0; i < validLocalPaths.length; i += 1) {
      sized.push({ path: validLocalPaths[i], originalIndex: i, size: sizes[i] ?? 0 });
    }
    sized.sort((a, b) => {
      if (b.size !== a.size) {
        return b.size - a.size;
      }
      return a.originalIndex - b.originalIndex;
    });
    scheduledPaths = sized.map((x) => x.path);
    scheduledToOriginal = sized.map((x) => x.originalIndex);
    console.log(`  size-schedule=on (${elapsedSince(scheduleStart)})`);
  } else {
    console.log("  size-schedule=off");
  }

  const datFd = fs.openSync(outDat, "w");
  try {
    fs.writeSync(datFd, Buffer.alloc(DAT_BLOCK_SIZE), 0, DAT_BLOCK_SIZE, null);
    const pendingWrites: Buffer[] = [];
    let pendingBytes = 0;
    const enqueueWrite = (buf: Buffer): void => {
      pendingWrites.push(buf);
      pendingBytes += buf.length;
      if (pendingBytes >= writeThreshold) {
        fs.writevSync(datFd, pendingWrites);
        pendingWrites.length = 0;
        pendingBytes = 0;
      }
    };
    const flushWrites = (): void => {
      if (pendingWrites.length > 0) {
        fs.writevSync(datFd, pendingWrites);
        pendingWrites.length = 0;
        pendingBytes = 0;
      }
    };

    for await (const result of compressFilesStream(scheduledPaths, compressLevel, activeJobs, false)) {
      const originalIndex = scheduledToOriginal ? scheduledToOriginal[result.index] : result.index;
      totalRawSize += result.rawSize;
      wrappedSizes[originalIndex] = result.wrapped.length;

      const blocksNeeded = Math.floor((result.wrapped.length + DAT_BLOCK_SIZE - 1) / DAT_BLOCK_SIZE);
      startBlocks[originalIndex] = currentBlock;

      enqueueWrite(result.wrapped);
      const padSize = blocksNeeded * DAT_BLOCK_SIZE - result.wrapped.length;
      if (padSize > 0) {
        enqueueWrite(zeroPad.subarray(0, padSize));
      }

      for (let b = 0; b < blocksNeeded; b += 1) {
        fatEntries.push(b < blocksNeeded - 1 ? currentBlock + 1 : 0xffffffff);
        currentBlock += 1;
      }

      processed += 1;
      if (processed % progressInterval === 0) {
        console.log(`  compressed ${processed.toLocaleString()} / ${validPaths.length.toLocaleString()} ...`);
      }
    }
    flushWrites();
  } finally {
    fs.closeSync(datFd);
  }

  const datSize = fs.statSync(outDat).size;
  console.log(`  DAT: ${datSize.toLocaleString()} bytes (${(datSize / 1048576).toFixed(1)} MB)`);
  console.log(`  FAT entries: ${fatEntries.length.toLocaleString()}`);
  console.log(`  Raw file data: ${totalRawSize.toLocaleString()} bytes (${(totalRawSize / 1048576).toFixed(1)} MB)`);
  if (totalRawSize > 0) {
    console.log(`  Compression ratio: ${((datSize / totalRawSize) * 100).toFixed(2)}%`);
  }
  console.log(`  Phase 3 elapsed: ${elapsedSince(phase3Start)}`);

  console.log("\nPhase 4: Building meta records and FAT...");
  const phase4Start = process.hrtime.bigint();
  const metaData = Buffer.alloc(validPaths.length * META_SIZE);
  for (let i = 0; i < validPaths.length; i += 1) {
    const meta = packMetaRecord(1, wrappedSizes[i], startBlocks[i], 0);
    meta.copy(metaData, i * META_SIZE);
  }
  console.log(`  Meta records: ${validPaths.length.toLocaleString()}, ${metaData.length.toLocaleString()} bytes`);

  const fatData = Buffer.alloc(fatEntries.length * 4);
  for (let i = 0; i < fatEntries.length; i += 1) {
    fatData.writeUInt32LE(fatEntries[i] >>> 0, i * 4);
  }
  console.log(`  FAT data: ${fatData.length.toLocaleString()} bytes`);
  console.log(`  Phase 4 elapsed: ${elapsedSince(phase4Start)}`);

  console.log(`\nPhase 5: Writing ${outIdx}...`);
  const phase5Start = process.hrtime.bigint();
  const idxSize = writeIdx(outIdx, dtData, stringData, metaData, fatData);
  console.log(`  IDX: ${idxSize.toLocaleString()} bytes`);
  console.log(`  Phase 5 elapsed: ${elapsedSince(phase5Start)}`);

  console.log("\n" + "=".repeat(70));
  console.log("REPACK SUMMARY");
  console.log("=".repeat(70));
  console.log(`Files repacked:       ${validPaths.length.toLocaleString()}`);
  console.log(`Files skipped:        ${skipped.toLocaleString()}`);
  console.log(`Files deduped:        ${deduped.toLocaleString()}`);
  console.log(`Total raw size:       ${totalRawSize.toLocaleString()} bytes (${(totalRawSize / 1048576).toFixed(1)} MB)`);
  console.log(`DAT size:             ${datSize.toLocaleString()} bytes (${(datSize / 1048576).toFixed(1)} MB)`);
  console.log(`IDX size:             ${idxSize.toLocaleString()} bytes (${(idxSize / 1048576).toFixed(1)} MB)`);
  const archiveTotal = datSize + idxSize;
  console.log(`Archive total:        ${archiveTotal.toLocaleString()} bytes (${(archiveTotal / 1048576).toFixed(1)} MB)`);
  if (totalRawSize > 0) {
    const saved = totalRawSize - datSize;
    console.log(`Space saved:          ${saved.toLocaleString()} bytes (${((1 - datSize / totalRawSize) * 100).toFixed(1)}%)`);
  }

  const stats: RepackStats = {
    files: validPaths.length,
    skipped,
    deduped,
    rawSize: totalRawSize,
    datSize,
    idxSize
  };

  if (verify) {
    console.log("\nPhase 6: Verifying...");
    const phase6Start = process.hrtime.bigint();
    const arc = new PriusArchive(outIdx, outDat);
    try {
      let verified = 0;
      let errors = 0;
      const localLookup = new Map<string, string>();
      for (let i = 0; i < validPaths.length; i += 1) {
        localLookup.set(validPaths[i], validLocalPaths[i]);
      }

      for (const entry of arc.iterEntries()) {
        const metaIdx = entry.node.metaIndex;
        if (metaIdx < 0 || metaIdx >= arc.metaCount) {
          continue;
        }
        try {
          const data = arc.readFileBytes(metaIdx);
          const localPath = localLookup.get(entry.path);
          if (localPath && fs.existsSync(localPath) && fs.statSync(localPath).isFile()) {
            const original = fs.readFileSync(localPath);
            if (!data.equals(original)) {
              console.log(`  CONTENT MISMATCH: ${entry.path} (extracted=${data.length}, original=${original.length})`);
              errors += 1;
              continue;
            }
          }
          verified += 1;
          if ((verified + errors) % progressInterval === 0) {
            console.log(`  verified ${(verified + errors).toLocaleString()} / ${validPaths.length.toLocaleString()} ...`);
          }
        } catch (e) {
          console.log(`  VERIFY FAIL: ${entry.path}: ${String(e)}`);
          errors += 1;
        }
      }

      console.log(`  Verified: ${verified.toLocaleString()}`);
      console.log(`  Errors: ${errors.toLocaleString()}`);
      console.log(`  Phase 6 elapsed: ${elapsedSince(phase6Start)}`);
      stats.verified = verified;
      stats.verifyErrors = errors;
    } finally {
      arc.close();
    }
  }

  console.log(`Total elapsed:        ${elapsedSince(totalStart)}`);

  return stats;
}

