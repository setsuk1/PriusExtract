import crypto from "node:crypto";
import fs from "node:fs";
import {
  DAT_BLOCK_SIZE,
  META_SIZE,
  PriusArchive,
  PriusIdx,
  MetaRecord,
  packMetaRecord,
  writeIdxChannelBytes,
  packU32
} from "../core/prius_archive.js";
import { compressFilesBatch } from "../core/prius_parallel_compress.js";
import { defaultJobs, elapsedSince, normalizeJobs } from "../core/prius_runtime.js";

interface PatchInput {
  requestedPath: string;
  archivePath: string;
  localPath: string;
  metaIdx: number;
  oldMeta: MetaRecord;
}

interface PreparedPatch extends PatchInput {
  wrapped: Buffer;
  rawSize: number;
  rawSha1: Buffer;
  wrappedSize: number;
  blocksNeeded: number;
  startBlock: number;
  oldMetaBytes: Buffer;
  newMetaBytes: Buffer;
}

interface PatchStats {
  patched: number;
  notFound: number;
  deduped: number;
  errors: number;
  wouldPatch?: number;
  rolledBack?: boolean;
}

function normalizeArchiveQueryPath(p: string): string {
  return p.replaceAll("/", "\\");
}

function resolveMetaForPath(arc: PriusArchive, archivePath: string): [string, number] {
  const query = normalizeArchiveQueryPath(archivePath);
  const candidates = [query];
  const lower = query.toLowerCase();
  if (lower !== query) {
    candidates.push(lower);
  }

  for (const candidate of candidates) {
    const [, metaIdx] = arc.findMeta(candidate);
    if (metaIdx >= 0) {
      return [candidate, metaIdx];
    }
  }
  return [query, -1];
}

function rollbackPatch(
  idxPath: string,
  datPath: string,
  idxLayout: PriusIdx,
  originalDatSize: number,
  originalFatSize: number,
  metaOldRecords: Array<{ metaIdx: number; oldMetaBytes: Buffer }>,
  metaChannel: number,
  fatChannel: number
): void {
  const datFd = fs.openSync(datPath, "r+");
  try {
    fs.ftruncateSync(datFd, originalDatSize);
    fs.fsyncSync(datFd);
  } finally {
    fs.closeSync(datFd);
  }

  const fatSizeHeaderOffset = 8 + fatChannel * 8 + 4;
  const idxFd = fs.openSync(idxPath, "r+");
  try {
    for (const rec of metaOldRecords) {
      writeIdxChannelBytes(idxFd, idxLayout, metaChannel, rec.metaIdx * META_SIZE, rec.oldMetaBytes);
    }
    fs.writeSync(idxFd, packU32(originalFatSize), 0, 4, fatSizeHeaderOffset);
    fs.fsyncSync(idxFd);
  } finally {
    fs.closeSync(idxFd);
  }
}

export async function patchFiles(
  idxPath: string,
  datPath: string,
  fileMap: Map<string, string>,
  compressLevel = 6,
  dryRun = false,
  jobs = defaultJobs()
): Promise<PatchStats> {
  const totalStart = process.hrtime.bigint();
  console.log("\nPhase 1: Resolving patch targets...");
  const phase1Start = process.hrtime.bigint();
  const arc = new PriusArchive(idxPath, datPath);
  let patches: PatchInput[] = [];
  let notFound = 0;
  let deduped = 0;
  let idxLayout: PriusIdx | null = null;
  let originalDatSize = 0;
  let originalFatSize = 0;
  let currentBlocks = 0;
  let fatChannel = 3;
  let metaChannel = 2;
  let newFatEntries = Buffer.alloc(0);
  let prepared: PreparedPatch[] = [];
  let newFatSize = 0;

  try {
    const seenMeta = new Set<number>();
    for (const [requestedPath, localPath] of fileMap.entries()) {
      const [resolvedPath, metaIdx] = resolveMetaForPath(arc, requestedPath);
      if (metaIdx < 0) {
        notFound += 1;
        continue;
      }
      if (seenMeta.has(metaIdx)) {
        deduped += 1;
        continue;
      }
      seenMeta.add(metaIdx);
      patches.push({
        requestedPath,
        archivePath: resolvedPath,
        localPath,
        metaIdx,
        oldMeta: arc.metaRecord(metaIdx)
      });
    }

    if (notFound > 0) {
      console.log(`WARNING: ${notFound} path(s) not found in archive (skipped).`);
    }
    if (deduped > 0) {
      console.log(`WARNING: ${deduped} duplicate target(s) map to the same archive entry (skipped).`);
    }

    if (patches.length === 0) {
      console.log("Nothing to patch.");
      console.log(`  Phase 1 elapsed: ${elapsedSince(phase1Start)}`);
      console.log(`Total elapsed:     ${elapsedSince(totalStart)}`);
      return { patched: 0, notFound, deduped, errors: 0 };
    }

    if (dryRun) {
      console.log(`Dry run: would patch ${patches.length} file(s):`);
      for (const patch of patches) {
        const localSize = fs.statSync(patch.localPath).size;
        console.log(`  ${patch.archivePath}`);
        console.log(`    requested: ${patch.requestedPath}`);
        console.log(`    local: ${patch.localPath} (${localSize.toLocaleString()} bytes)`);
        console.log(`    old wrapped size: ${patch.oldMeta.size.toLocaleString()} bytes`);
      }
      console.log(`  Phase 1 elapsed: ${elapsedSince(phase1Start)}`);
      console.log(`Total elapsed:     ${elapsedSince(totalStart)}`);
      return { patched: 0, wouldPatch: patches.length, notFound, deduped, errors: 0 };
    }

    originalDatSize = fs.statSync(datPath).size;
    if (originalDatSize % DAT_BLOCK_SIZE !== 0) {
      throw new Error(`DAT size is not ${DAT_BLOCK_SIZE}-byte aligned (${originalDatSize} bytes)`);
    }
    currentBlocks = Math.floor(originalDatSize / DAT_BLOCK_SIZE);
    if (arc.fatEntryCount !== currentBlocks) {
      throw new Error(`DAT/FAT mismatch: DAT has ${currentBlocks} blocks but FAT has ${arc.fatEntryCount} entries`);
    }

    idxLayout = arc.idx;
    originalFatSize = idxLayout.channels[fatChannel].sizeBytes;
    if (originalFatSize !== arc.fatEntryCount * 4) {
      throw new Error(`IDX FAT size mismatch: header=${originalFatSize}, parsed entries=${arc.fatEntryCount}`);
    }

    console.log(`  Targets resolved: ${patches.length.toLocaleString()}`);
    console.log(`  Phase 1 elapsed: ${elapsedSince(phase1Start)}`);

    console.log("\nPhase 2: Preparing patch payloads...");
    const phase2Start = process.hrtime.bigint();
    const activeJobs = normalizeJobs(jobs, patches.length);
    console.log(`  Preparing ${patches.length} file(s)... jobs=${activeJobs}`);
    const newFatWords: number[] = [];
    let blockCursor = currentBlocks;
    const compressed = await compressFilesBatch(
      patches.map((p) => p.localPath),
      compressLevel,
      activeJobs,
      true
    );

    for (let i = 0; i < patches.length; i += 1) {
      const patch = patches[i];
      const result = compressed[i];
      const wrappedSize = result.wrapped.length;
      const blocksNeeded = Math.floor((wrappedSize + DAT_BLOCK_SIZE - 1) / DAT_BLOCK_SIZE);
      const startBlock = blockCursor;

      for (let b = 0; b < blocksNeeded; b += 1) {
        newFatWords.push(b < blocksNeeded - 1 ? blockCursor + 1 : 0xffffffff);
        blockCursor += 1;
      }

      const oldMetaBytes = packMetaRecord(
        patch.oldMeta.flags,
        patch.oldMeta.size,
        patch.oldMeta.startBlock,
        patch.oldMeta.extra
      );
      const newMetaBytes = packMetaRecord(
        patch.oldMeta.flags | 1,
        wrappedSize,
        startBlock,
        patch.oldMeta.extra
      );

      prepared.push({
        ...patch,
        wrapped: result.wrapped,
        rawSize: result.rawSize,
        rawSha1: result.rawSha1,
        wrappedSize,
        blocksNeeded,
        startBlock,
        oldMetaBytes,
        newMetaBytes
      });

      console.log(
        `  [${i + 1}/${patches.length}] ${patch.archivePath} (${wrappedSize.toLocaleString()} bytes, ${blocksNeeded} blocks)`
      );
    }

    const totalNewBlocks = blockCursor - currentBlocks;
    newFatSize = (currentBlocks + totalNewBlocks) * 4;

    newFatEntries = Buffer.alloc(newFatWords.length * 4);
    for (let i = 0; i < newFatWords.length; i += 1) {
      newFatEntries.writeUInt32LE(newFatWords[i] >>> 0, i * 4);
    }

    const stripes = idxLayout.stripes;
    const fatCh = idxLayout.channels[fatChannel];
    const fatCapacity = stripes * fatCh.pagesPerStripe * idxLayout.pageSize;
    if (newFatSize > fatCapacity) {
      throw new Error(`FAT channel capacity exceeded: need ${newFatSize}, channel has ${fatCapacity}`);
    }

    const metaCh = idxLayout.channels[metaChannel];
    const metaCapacity = stripes * metaCh.pagesPerStripe * idxLayout.pageSize;
    for (const patch of prepared) {
      const metaOffset = patch.metaIdx * META_SIZE;
      if (metaOffset + META_SIZE > metaCapacity) {
        throw new Error(`Meta index out of capacity: meta_idx=${patch.metaIdx}, capacity=${metaCapacity}`);
      }
    }
    console.log(`  Phase 2 elapsed: ${elapsedSince(phase2Start)}`);
  } finally {
    arc.close();
  }

  let datAppended = false;
  let idxUpdated = false;
  let rolledBack = false;
  const fatSizeHeaderOffset = 8 + fatChannel * 8 + 4;

  try {
    console.log("\nPhase 3: Writing DAT and IDX updates...");
    const phase3Start = process.hrtime.bigint();
    const zeroPad = Buffer.alloc(DAT_BLOCK_SIZE);
    const writeThreshold = 8 * 1024 * 1024;
    const datFd = fs.openSync(datPath, "r+");
    try {
      const curSize = fs.fstatSync(datFd).size;
      if (curSize !== originalDatSize) {
        throw new Error("DAT size changed during patch preparation; aborting.");
      }
      let writePos = curSize;
      const pendingWrites: Buffer[] = [];
      let pendingBytes = 0;
      const enqueueWrite = (buf: Buffer): void => {
        pendingWrites.push(buf);
        pendingBytes += buf.length;
      };
      const flushWrites = (): void => {
        if (pendingWrites.length === 0) {
          return;
        }
        fs.writevSync(datFd, pendingWrites, writePos);
        writePos += pendingBytes;
        pendingWrites.length = 0;
        pendingBytes = 0;
      };

      for (const patch of prepared) {
        enqueueWrite(patch.wrapped);
        const padSize = patch.blocksNeeded * DAT_BLOCK_SIZE - patch.wrapped.length;
        if (padSize > 0) {
          enqueueWrite(zeroPad.subarray(0, padSize));
        }
        if (pendingBytes >= writeThreshold) {
          flushWrites();
        }
      }
      flushWrites();
      fs.fsyncSync(datFd);
    } finally {
      fs.closeSync(datFd);
    }
    datAppended = true;

    if (!idxLayout) {
      throw new Error("internal error: idx layout missing");
    }
    const idxFd = fs.openSync(idxPath, "r+");
    try {
      writeIdxChannelBytes(idxFd, idxLayout, fatChannel, originalFatSize, newFatEntries);
      fs.writeSync(idxFd, packU32(newFatSize), 0, 4, fatSizeHeaderOffset);
      for (const patch of prepared) {
        writeIdxChannelBytes(idxFd, idxLayout, metaChannel, patch.metaIdx * META_SIZE, patch.newMetaBytes);
      }
      fs.fsyncSync(idxFd);
    } finally {
      fs.closeSync(idxFd);
    }
    idxUpdated = true;
    console.log(`  Phase 3 elapsed: ${elapsedSince(phase3Start)}`);

    console.log("\nPhase 4: Verifying patched files...");
    const phase4Start = process.hrtime.bigint();
    let errors = 0;
    const verifyArc = new PriusArchive(idxPath, datPath);
    try {
      for (const patch of prepared) {
        try {
          const extracted = verifyArc.readFileBytes(patch.metaIdx);
          const extractedSha1 = crypto.createHash("sha1").update(extracted).digest();
          if (extracted.length !== patch.rawSize || !extractedSha1.equals(patch.rawSha1)) {
            console.log(
              `  MISMATCH: ${patch.archivePath} (extracted=${extracted.length}, expected=${patch.rawSize})`
            );
            errors += 1;
          }
        } catch (e) {
          console.log(`  ERROR: ${patch.archivePath}: ${String(e)}`);
          errors += 1;
        }
      }
    } finally {
      verifyArc.close();
    }

    if (errors > 0) {
      throw new Error(`${errors} verification error(s) after patch.`);
    }

    console.log(`All ${prepared.length} patched file(s) verified OK.`);
    console.log(`  Phase 4 elapsed: ${elapsedSince(phase4Start)}`);
    console.log(`Total elapsed:     ${elapsedSince(totalStart)}`);
    return { patched: prepared.length, notFound, deduped, errors: 0, rolledBack };
  } catch (e) {
    if ((datAppended || idxUpdated) && idxLayout) {
      console.log("\nPatch failed; rolling back partial changes...");
      const oldRecords = prepared.map((p) => ({ metaIdx: p.metaIdx, oldMetaBytes: p.oldMetaBytes }));
      rollbackPatch(
        idxPath,
        datPath,
        idxLayout,
        originalDatSize,
        originalFatSize,
        oldRecords,
        metaChannel,
        fatChannel
      );
      rolledBack = true;
      console.log("Rollback completed.");
    }
    console.log(`Elapsed before failure: ${elapsedSince(totalStart)}`);
    throw e;
  }
}

