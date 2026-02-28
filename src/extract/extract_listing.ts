import { PriusArchive } from "../core/prius_archive.js";
import { getOrphanStrings } from "./extract_shared.js";

export function cmdListDt(idxPath: string, datPath: string | null, onlyFiles: boolean): number {
  const arc = new PriusArchive(idxPath, datPath ?? undefined);
  try {
    let count = 0;
    for (const entry of arc.iterEntries()) {
      const metaIdx = entry.node.metaIndex;
      if (metaIdx < 0 || metaIdx >= arc.metaCount) {
        continue;
      }
      const meta = arc.metaRecord(metaIdx);
      if (onlyFiles && meta.size === 0) {
        continue;
      }
      console.log(entry.path);
      count += 1;
    }
    console.error(`\n# Total: ${count}`);
    return 0;
  } finally {
    arc.close();
  }
}

export function cmdListOrphans(idxPath: string, datPath: string | null): number {
  const arc = new PriusArchive(idxPath, datPath ?? undefined);
  try {
    const orphans = getOrphanStrings(arc);
    for (const idx of [...orphans.keys()].sort((a, b) => a - b)) {
      console.log(`${idx}\t${orphans.get(idx)!}`);
    }
    console.error(`\n# Total orphan strings: ${orphans.size}`);
    return 0;
  } finally {
    arc.close();
  }
}

export function cmdInfo(idxPath: string, datPath: string | null): number {
  const arc = new PriusArchive(idxPath, datPath ?? undefined);
  try {
    console.log(`IDX file:           ${idxPath}`);
    console.log(`Page size:          0x${arc.idx.pageSize.toString(16)}`);
    console.log(`Stripes:            ${arc.idx.stripes}`);
    console.log("Channels:");
    arc.idx.channels.forEach((ch, i) => {
      console.log(`  ${i}: pages/stripe=${ch.pagesPerStripe}  size=0x${ch.sizeBytes.toString(16)}`);
    });
    console.log("");
    console.log(`DT node count:      ${arc.dtNodeCount.toLocaleString()}`);
    console.log(`Meta record count:  ${arc.metaCount.toLocaleString()}`);
    console.log(`String records:     ${arc.stringRecordCount.toLocaleString()}`);
    console.log(`FAT entries:        ${arc.fatEntryCount.toLocaleString()}`);
    console.log("");

    const orphans = getOrphanStrings(arc);
    console.log(`Orphan strings:     ${orphans.size.toLocaleString()}  (in string table, no DT node)`);

    let extractable = 0;
    for (const entry of arc.iterEntries()) {
      const metaIdx = entry.node.metaIndex;
      if (metaIdx < 0 || metaIdx >= arc.metaCount) {
        continue;
      }
      if (arc.metaRecord(metaIdx).size > 0) {
        extractable += 1;
      }
    }
    console.log(`Extractable files:  ${extractable.toLocaleString()}`);
    return 0;
  } finally {
    arc.close();
  }
}
