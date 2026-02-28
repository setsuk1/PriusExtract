import fs from "node:fs";
import path from "node:path";
import { PriusArchive, safeOutputPath, winExtPath } from "../core/prius_archive.js";
import { elapsedSince } from "../core/prius_runtime.js";
import { EntryRef, loadFullList } from "./extract_shared.js";

export function cmdExtractAll(
  idxPath: string,
  datPath: string,
  outDir: string,
  keepGoing: boolean,
  skipExisting: boolean
): number {
  fs.mkdirSync(outDir, { recursive: true });
  const arc = new PriusArchive(idxPath, datPath);
  try {
    console.log("\nPhase 1: Extracting files...");
    const phase1Start = process.hrtime.bigint();
    let total = 0;
    let extracted = 0;
    let skipped = 0;
    let failed = 0;
    const failures: Array<{ path: string; error: string }> = [];

    for (const entry of arc.iterEntries()) {
      const metaIdx = entry.node.metaIndex;
      if (metaIdx < 0 || metaIdx >= arc.metaCount) {
        continue;
      }
      const meta = arc.metaRecord(metaIdx);
      if (meta.size === 0) {
        continue;
      }
      total += 1;

      const dest = safeOutputPath(outDir, entry.path);
      const destExt = winExtPath(dest);
      if (skipExisting) {
        try {
          if (fs.existsSync(destExt) && fs.statSync(destExt).size > 0) {
            skipped += 1;
            continue;
          }
        } catch {
          // ignore stat errors
        }
      }

      let data: Buffer;
      try {
        data = arc.readFileBytes(metaIdx);
      } catch (e) {
        failed += 1;
        failures.push({ path: entry.path, error: `decode: ${String(e)}` });
        if (!keepGoing) {
          throw e;
        }
        continue;
      }

      try {
        fs.mkdirSync(winExtPath(path.dirname(dest)), { recursive: true });
        fs.writeFileSync(destExt, data);
        extracted += 1;
      } catch (e) {
        failed += 1;
        failures.push({ path: entry.path, error: `write: ${String(e)}` });
        if (!keepGoing) {
          throw e;
        }
      }

      if (extracted % 5000 === 0) {
        console.log(`  extracted ${extracted.toLocaleString()} / ~${total.toLocaleString()} ...`);
      }
    }

    console.log("\n" + "=".repeat(70));
    console.log("EXTRACTION SUMMARY");
    console.log("=".repeat(70));
    console.log(`DT entries with data:  ${total.toLocaleString()}`);
    console.log(`Extracted:             ${extracted.toLocaleString()}`);
    console.log(`Skipped (existing):    ${skipped.toLocaleString()}`);
    console.log(`Failed:                ${failed.toLocaleString()}`);
    if (failures.length > 0) {
      console.log(`\nFailed files (first 20 of ${failures.length.toLocaleString()}):`);
      for (const f of failures.slice(0, 20)) {
        console.log(`  ${f.path}: ${f.error}`);
      }
    }
    console.log(`Phase 1 elapsed:       ${elapsedSince(phase1Start)}`);
    return failed === 0 ? 0 : 1;
  } finally {
    arc.close();
  }
}

export function cmdExtractList(
  idxPath: string,
  datPath: string,
  fullListPath: string,
  outDir: string,
  keepGoing: boolean,
  skipExisting: boolean,
  reportPath: string | null
): number {
  const fullList = loadFullList(fullListPath);
  fs.mkdirSync(outDir, { recursive: true });

  const arc = new PriusArchive(idxPath, datPath);
  try {
    console.log("\nPhase 1: Building DT lookup...");
    const phase1Start = process.hrtime.bigint();
    const dtLookup = new Map<string, EntryRef>();
    for (const entry of arc.iterEntries()) {
      const metaIdx = entry.node.metaIndex;
      if (metaIdx < 0 || metaIdx >= arc.metaCount) {
        continue;
      }
      const key = entry.path.toLowerCase();
      if (!dtLookup.has(key)) {
        dtLookup.set(key, { metaIdx, path: entry.path });
      }
    }
    console.log(`  DT entries indexed:  ${dtLookup.size.toLocaleString()}`);
    console.log(`  Phase 1 elapsed:     ${elapsedSince(phase1Start)}`);

    console.log("\nPhase 2: Extracting files from list...");
    const phase2Start = process.hrtime.bigint();

    let extracted = 0;
    let skipped = 0;
    let missing = 0;
    let failed = 0;
    const failures: Array<{ path: string; error: string }> = [];
    const missingPaths: string[] = [];

    for (const wanted of fullList) {
      const hit = dtLookup.get(wanted.toLowerCase());
      if (!hit) {
        missing += 1;
        missingPaths.push(wanted);
        continue;
      }
      const meta = arc.metaRecord(hit.metaIdx);
      if (meta.size === 0) {
        missing += 1;
        missingPaths.push(wanted);
        continue;
      }

      const dest = safeOutputPath(outDir, hit.path);
      const destExt = winExtPath(dest);
      if (skipExisting) {
        try {
          if (fs.existsSync(destExt) && fs.statSync(destExt).size > 0) {
            skipped += 1;
            continue;
          }
        } catch {
          // ignore
        }
      }

      let data: Buffer;
      try {
        data = arc.readFileBytes(hit.metaIdx);
      } catch (e) {
        failed += 1;
        failures.push({ path: hit.path, error: `decode: ${String(e)}` });
        if (!keepGoing) {
          throw e;
        }
        continue;
      }

      try {
        fs.mkdirSync(winExtPath(path.dirname(dest)), { recursive: true });
        fs.writeFileSync(destExt, data);
        extracted += 1;
      } catch (e) {
        failed += 1;
        failures.push({ path: hit.path, error: `write: ${String(e)}` });
        if (!keepGoing) {
          throw e;
        }
        continue;
      }

      if (extracted % 5000 === 0) {
        console.log(`  extracted ${extracted.toLocaleString()} ...`);
      }
    }

    console.log("\n" + "=".repeat(70));
    console.log("EXTRACTION SUMMARY (from full list)");
    console.log("=".repeat(70));
    console.log(`Full list entries:     ${fullList.length.toLocaleString()}`);
    console.log(`Extracted:             ${extracted.toLocaleString()}`);
    console.log(`Skipped (existing):    ${skipped.toLocaleString()}`);
    console.log(`Missing from DT:       ${missing.toLocaleString()}`);
    console.log(`Failed:                ${failed.toLocaleString()}`);

    if (reportPath) {
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      const lines = ["status\tpath"];
      for (const p of missingPaths) {
        lines.push(`missing\t${p}`);
      }
      for (const f of failures) {
        lines.push(`failed\t${f.path}\t${f.error}`);
      }
      fs.writeFileSync(reportPath, `${lines.join("\n")}\n`, "utf8");
      console.log(`Report:                ${reportPath}`);
    }

    if (failures.length > 0) {
      console.log(`\nFailed files (first 20 of ${failures.length.toLocaleString()}):`);
      for (const f of failures.slice(0, 20)) {
        console.log(`  ${f.path}: ${f.error}`);
      }
    }

    console.log(`Phase 2 elapsed:       ${elapsedSince(phase2Start)}`);
    return failed === 0 ? 0 : 1;
  } finally {
    arc.close();
  }
}
