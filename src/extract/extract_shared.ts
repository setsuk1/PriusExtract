import fs from "node:fs";
import { PriusArchive } from "../core/prius_archive.js";

export interface EntryRef {
  metaIdx: number;
  path: string;
}

export function loadFullList(listPath: string): string[] {
  return fs
    .readFileSync(listPath, "utf8")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function getOrphanStrings(arc: PriusArchive): Map<number, string> {
  const nextTargets = new Set<number>();
  for (let i = 1; i < arc.stringRecordCount; i += 1) {
    const header = arc.stringRecordHeader(i);
    const nxt = header & 0x7fffffff;
    if (nxt > 0 && nxt < arc.stringRecordCount) {
      nextTargets.add(nxt);
    }
  }

  const dtStrings = new Set<number>();
  for (let nodeIdx = 0; nodeIdx < arc.dtNodeCount; nodeIdx += 1) {
    const node = arc.dtNode(nodeIdx);
    dtStrings.add(node.nameRaw & 0x7fffffff);
  }

  const orphans = new Map<number, string>();
  for (let i = 1; i < arc.stringRecordCount; i += 1) {
    if (nextTargets.has(i) || dtStrings.has(i)) {
      continue;
    }
    try {
      const s = arc.stringBytes(i).toString("utf8");
      if (s.length > 0) {
        orphans.set(i, s);
      }
    } catch {
      // skip malformed chains
    }
  }
  return orphans;
}
