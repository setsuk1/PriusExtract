import fs from "node:fs";

const MAGIC = Buffer.from("ABCD", "ascii");
const PAGE_SIZE = 0x1000;
const DEFAULT_PPS = [4, 8, 1, 4];

export function writeIdx(
  outPath: string,
  dtData: Buffer,
  stringData: Buffer,
  metaData: Buffer,
  fatData: Buffer,
  pageSize = PAGE_SIZE,
  pagesPerStripe: number[] = DEFAULT_PPS
): number {
  const channelData = [dtData, stringData, metaData, fatData];
  if (pagesPerStripe.length !== channelData.length) {
    throw new Error("pages_per_stripe length mismatch");
  }

  const channelSizes = channelData.map((d) => d.length);
  const pagesNeeded = channelSizes.map((size) => Math.floor((size + pageSize - 1) / pageSize));
  const sumPps = pagesPerStripe.reduce((a, b) => a + b, 0);

  let stripes = 0;
  for (let i = 0; i < channelData.length; i += 1) {
    const needed = Math.floor((pagesNeeded[i] + pagesPerStripe[i] - 1) / pagesPerStripe[i]);
    stripes = Math.max(stripes, needed);
  }

  const totalDataPages = stripes * sumPps;
  const totalPages = 1 + totalDataPages;
  const fileSize = totalPages * pageSize;

  const header = Buffer.alloc(pageSize);
  MAGIC.copy(header, 0);
  header.writeUInt32LE(channelData.length, 4);
  for (let i = 0; i < channelData.length; i += 1) {
    const off = 8 + i * 8;
    header.writeUInt32LE(pagesPerStripe[i], off);
    header.writeUInt32LE(channelSizes[i], off + 4);
  }

  const chanPrefix: number[] = [];
  let prefix = 0;
  for (const pps of pagesPerStripe) {
    chanPrefix.push(prefix);
    prefix += pps;
  }

  const physOffset = (channel: number, channelPage: number): number => {
    const pps = pagesPerStripe[channel];
    const stripe = Math.floor(channelPage / pps);
    const pageInStripe = channelPage % pps;
    const physPage = stripe * sumPps + chanPrefix[channel] + pageInStripe;
    return pageSize + physPage * pageSize;
  };

  const fd = fs.openSync(outPath, "w");
  try {
    fs.ftruncateSync(fd, fileSize);
    fs.writeSync(fd, header, 0, header.length, 0);

    for (let ch = 0; ch < channelData.length; ch += 1) {
      const data = channelData[ch];
      const pages = Math.floor((data.length + pageSize - 1) / pageSize);
      for (let pg = 0; pg < pages; pg += 1) {
        const off = pg * pageSize;
        const chunk = Buffer.alloc(pageSize);
        data.copy(chunk, 0, off, off + pageSize);
        fs.writeSync(fd, chunk, 0, chunk.length, physOffset(ch, pg));
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  return fileSize;
}
