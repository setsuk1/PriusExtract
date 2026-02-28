import fs from "node:fs";
import path from "node:path";
import { PriusArchive } from "../core/prius_archive.js";
import { getOrphanStrings, loadFullList } from "./extract_shared.js";

export function cmdCompare(idxPath: string, datPath: string | null, fullListPath: string, reportPath: string | null): number {
  const fullList = loadFullList(fullListPath);
  const fullSet = new Set<string>();
  const fullLowerMap = new Map<string, string>();
  for (const p of fullList) {
    const key = p.toLowerCase();
    fullSet.add(key);
    fullLowerMap.set(key, p);
  }

  const arc = new PriusArchive(idxPath, datPath ?? undefined);
  let dtSet = new Set<string>();
  const dtMap = new Map<string, string>();
  let orphanSet = new Set<string>();
  try {
    for (const entry of arc.iterEntries()) {
      const metaIdx = entry.node.metaIndex;
      if (metaIdx < 0 || metaIdx >= arc.metaCount) {
        continue;
      }
      const key = entry.path.toLowerCase();
      dtSet.add(key);
      dtMap.set(key, entry.path);
    }
    const orphans = getOrphanStrings(arc);
    orphanSet = new Set([...orphans.values()].map((s) => s.toLowerCase()));
  } finally {
    arc.close();
  }

  const inBoth = [...fullSet].filter((k) => dtSet.has(k));
  const inFullOnly = [...fullSet].filter((k) => !dtSet.has(k));
  const inDtOnly = [...dtSet].filter((k) => !fullSet.has(k));
  const inFullOrphan = inFullOnly.filter((k) => orphanSet.has(k));
  const inFullAbsent = inFullOnly.filter((k) => !orphanSet.has(k));

  console.log("=".repeat(70));
  console.log("COMPARISON: Full List vs DT Trie");
  console.log("=".repeat(70));
  console.log(`Full list entries:      ${fullList.length.toLocaleString()} (${fullSet.size.toLocaleString()} unique)`);
  console.log(`DT trie entries:        ${dtSet.size.toLocaleString()}`);
  console.log(`Orphan strings:         ${orphanSet.size.toLocaleString()}`);
  console.log("");
  console.log(`In both (extractable):  ${inBoth.length.toLocaleString()}`);
  console.log(`In full list only:      ${inFullOnly.length.toLocaleString()}`);
  console.log(`  - orphan (in string table, no DT node): ${inFullOrphan.length.toLocaleString()}`);
  console.log(`  - absent (not in idx at all):            ${inFullAbsent.length.toLocaleString()}`);
  console.log(`In DT only:             ${inDtOnly.length.toLocaleString()}`);

  if (reportPath) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    const lines: string[] = ["status\tpath"];
    for (const key of [...inBoth].sort()) {
      lines.push(`ok\t${fullLowerMap.get(key) ?? dtMap.get(key) ?? key}`);
    }
    for (const key of [...inFullOrphan].sort()) {
      lines.push(`orphan\t${fullLowerMap.get(key) ?? key}`);
    }
    for (const key of [...inFullAbsent].sort()) {
      lines.push(`absent\t${fullLowerMap.get(key) ?? key}`);
    }
    for (const key of [...inDtOnly].sort()) {
      lines.push(`dt_only\t${dtMap.get(key) ?? key}`);
    }
    fs.writeFileSync(reportPath, `${lines.join("\n")}\n`, "utf8");
    console.log(`\nReport written to: ${reportPath}`);
  } else if (inFullOnly.length > 0) {
    console.log("\nFirst 20 missing from DT:");
    for (const key of [...inFullOnly].sort().slice(0, 20)) {
      const status = orphanSet.has(key) ? "orphan" : "absent";
      console.log(`  [${status.padEnd(6)}] ${fullLowerMap.get(key) ?? key}`);
    }
  }

  return 0;
}
