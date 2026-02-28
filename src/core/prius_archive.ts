import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export const FILE_WRAPPER_HEADER_SIZE = 0x20;
export const DAT_BLOCK_SIZE = 0x200;
export const DT_NODE_SIZE = 0x14;
export const META_SIZE = 0x10;

function readU32(buf: Buffer, off: number): number {
  return buf.readUInt32LE(off);
}

function readI32(buf: Buffer, off: number): number {
  return buf.readInt32LE(off);
}

function writeU32LE(value: number): Buffer {
  const out = Buffer.allocUnsafe(4);
  out.writeUInt32LE(value >>> 0, 0);
  return out;
}

export interface IdxChannel {
  pagesPerStripe: number;
  sizeBytes: number;
}

export interface DtNode {
  metaIndex: number;
  bitIndex: number;
  nameRaw: number;
  leftRaw: number;
  rightRaw: number;
}

export interface MetaRecord {
  flags: number;
  size: number;
  startBlock: number;
  extra: number;
}

export class PriusIdx {
  public readonly idxPath: string;
  public readonly channels: IdxChannel[];
  public readonly pageSize: number;
  public readonly stripes: number;

  private readonly mm: Buffer;
  private readonly fileSize: number;
  private readonly sumPages: number;
  private readonly chanPrefixPages: number[];
  private readonly channelCache = new Map<number, Buffer>();

  constructor(idxPath: string) {
    this.idxPath = idxPath;
    this.mm = fs.readFileSync(idxPath);
    this.fileSize = this.mm.length;

    const magic = this.mm.subarray(0, 4);
    if (!magic.equals(Buffer.from("ABCD", "ascii"))) {
      throw new Error(`Unexpected magic ${magic.toString("hex")} (expected ABCD)`);
    }

    const channelCount = readU32(this.mm, 4);
    if (channelCount <= 0 || channelCount > 16) {
      throw new Error(`Suspicious channel_count=${channelCount}`);
    }

    const channels: IdxChannel[] = [];
    let offset = 8;
    for (let i = 0; i < channelCount; i += 1) {
      const pagesPerStripe = readU32(this.mm, offset);
      const sizeBytes = readU32(this.mm, offset + 4);
      channels.push({ pagesPerStripe, sizeBytes });
      offset += 8;
    }
    this.channels = channels;

    this.pageSize = this.inferPageSize();
    this.sumPages = this.channels.reduce((acc, ch) => acc + ch.pagesPerStripe, 0);

    const chanPrefixPages: number[] = [];
    let prefix = 0;
    for (const ch of this.channels) {
      chanPrefixPages.push(prefix);
      prefix += ch.pagesPerStripe;
    }
    this.chanPrefixPages = chanPrefixPages;

    const totalPages = Math.floor(this.fileSize / this.pageSize);
    const dataPages = totalPages - 1;
    this.stripes = Math.floor(dataPages / this.sumPages);
  }

  close(): void {
    this.channelCache.clear();
  }

  private inferPageSize(): number {
    const pps = this.channels.map((c) => c.pagesPerStripe);
    const sumPages = pps.reduce((a, b) => a + b, 0);
    if (sumPages <= 0) {
      throw new Error("Invalid pages-per-stripe configuration");
    }

    const candidates = [0x200, 0x400, 0x800, 0x1000, 0x2000, 0x4000, 0x8000];
    const viable: number[] = [];

    for (const pageSize of candidates) {
      if (this.fileSize % pageSize !== 0) {
        continue;
      }
      const totalPages = Math.floor(this.fileSize / pageSize);
      if (totalPages < 2) {
        continue;
      }
      const dataPages = totalPages - 1;
      if (dataPages % sumPages !== 0) {
        continue;
      }
      const stripes = Math.floor(dataPages / sumPages);

      let ok = true;
      for (const ch of this.channels) {
        const cap = stripes * ch.pagesPerStripe * pageSize;
        if (ch.sizeBytes > cap) {
          ok = false;
          break;
        }
      }
      if (ok) {
        viable.push(pageSize);
      }
    }

    if (viable.length === 0) {
      throw new Error("Could not infer idx page size");
    }
    if (viable.includes(0x1000)) {
      return 0x1000;
    }
    return Math.min(...viable);
  }

  private physOffsetForChannelPage(channel: number, channelPage: number): number {
    const pps = this.channels[channel].pagesPerStripe;
    const stripe = Math.floor(channelPage / pps);
    const pageInStripe = channelPage % pps;
    const physPage = stripe * this.sumPages + this.chanPrefixPages[channel] + pageInStripe;
    return this.pageSize + physPage * this.pageSize;
  }

  channelOffsetToFileOffset(channel: number, channelOffset: number): number {
    const page = Math.floor(channelOffset / this.pageSize);
    const inPage = channelOffset % this.pageSize;
    return this.physOffsetForChannelPage(channel, page) + inPage;
  }

  readChannel(channel: number): Buffer {
    const cached = this.channelCache.get(channel);
    if (cached) {
      return cached;
    }

    const ch = this.channels[channel];
    const pageCount = Math.floor((ch.sizeBytes + this.pageSize - 1) / this.pageSize);
    const out = Buffer.alloc(pageCount * this.pageSize);

    for (let page = 0; page < pageCount; page += 1) {
      const off = this.physOffsetForChannelPage(channel, page);
      this.mm.copy(out, page * this.pageSize, off, off + this.pageSize);
    }

    const data = out.subarray(0, ch.sizeBytes);
    this.channelCache.set(channel, data);
    return data;
  }
}

export class PriusArchive {
  public readonly idx: PriusIdx;
  public readonly datPath?: string;
  public readonly dtNodeCount: number;
  public readonly metaCount: number;
  public readonly stringRecordCount: number;
  public readonly fatEntryCount: number;

  private readonly dt: Buffer;
  private readonly strings: Buffer;
  private readonly meta: Buffer;
  private readonly fat: Buffer;
  private datFd: number | null = null;
  private readonly stringCache = new Map<number, Buffer>();

  constructor(idxPath: string, datPath?: string) {
    this.idx = new PriusIdx(idxPath);
    this.datPath = datPath;

    this.dt = this.idx.readChannel(0);
    this.strings = this.idx.readChannel(1);
    this.meta = this.idx.readChannel(2);
    this.fat = this.idx.readChannel(3);

    this.dtNodeCount = Math.floor(this.dt.length / DT_NODE_SIZE);
    this.metaCount = Math.floor(this.meta.length / META_SIZE);
    this.stringRecordCount = Math.floor(this.strings.length / 0x40);
    this.fatEntryCount = Math.floor(this.fat.length / 4);
  }

  close(): void {
    if (this.datFd !== null) {
      fs.closeSync(this.datFd);
      this.datFd = null;
    }
    this.stringCache.clear();
    this.idx.close();
  }

  dtNode(nodeIndex: number): DtNode {
    const off = nodeIndex * DT_NODE_SIZE;
    if (off < 0 || off + DT_NODE_SIZE > this.dt.length) {
      throw new Error(`DT node index out of range: ${nodeIndex}`);
    }
    return {
      metaIndex: readU32(this.dt, off),
      bitIndex: readI32(this.dt, off + 4),
      nameRaw: readU32(this.dt, off + 8),
      leftRaw: readU32(this.dt, off + 12),
      rightRaw: readU32(this.dt, off + 16)
    };
  }

  metaRecord(metaIndex: number): MetaRecord {
    const off = metaIndex * META_SIZE;
    if (off < 0 || off + META_SIZE > this.meta.length) {
      throw new Error(`Meta index out of range: ${metaIndex}`);
    }
    return {
      flags: readU32(this.meta, off),
      size: readU32(this.meta, off + 4),
      startBlock: readU32(this.meta, off + 8),
      extra: readU32(this.meta, off + 12)
    };
  }

  fatNext(blockId: number): number {
    const off = blockId * 4;
    if (off < 0 || off + 4 > this.fat.length) {
      throw new Error(`FAT block id out of range: ${blockId}`);
    }
    return readU32(this.fat, off);
  }

  stringBytes(stringIndex: number): Buffer {
    const cached = this.stringCache.get(stringIndex);
    if (cached) {
      return cached;
    }
    if (stringIndex < 0) {
      return Buffer.alloc(0);
    }

    const seen = new Set<number>();
    const chunks: Buffer[] = [];
    let idx = stringIndex;

    while (idx >= 0) {
      if (seen.has(idx)) {
        throw new Error(`String index loop detected at ${idx}`);
      }
      seen.add(idx);

      const off = idx * 0x40;
      if (off < 0 || off + 0x40 > this.strings.length) {
        throw new Error(`String record index out of range: ${idx}`);
      }

      const header = readU32(this.strings, off);
      const nxt = header & 0x7fffffff;
      const chunk = this.strings.subarray(off + 4, off + 0x40);
      const nul = chunk.indexOf(0);
      if (nul !== -1) {
        chunks.push(chunk.subarray(0, nul));
        break;
      }

      chunks.push(chunk);
      if (nxt === 0) {
        break;
      }
      idx = nxt;
    }

    const out = Buffer.concat(chunks);
    this.stringCache.set(stringIndex, out);
    return out;
  }

  stringRecordHeader(recordIndex: number): number {
    const off = recordIndex * 0x40;
    if (off < 0 || off + 4 > this.strings.length) {
      throw new Error(`String record index out of range: ${recordIndex}`);
    }
    return readU32(this.strings, off);
  }

  private getBit(key: Buffer, bitIndex: number): number {
    if (bitIndex < 0) {
      return 2;
    }
    const byteIndex = bitIndex >> 3;
    if (byteIndex >= key.length) {
      return 0;
    }
    return (key[byteIndex] >> (bitIndex & 7)) & 1;
  }

  findNode(key: string): number {
    const keyNorm = key.replaceAll("/", "\\");
    const keyBytes = Buffer.from(keyNorm, "utf8");
    if (keyBytes.length === 0) {
      return -1;
    }

    let parent = 0;
    let node = this.dtNode(0).rightRaw;

    while (this.dtNode(parent).bitIndex < this.dtNode(node).bitIndex) {
      parent = node;
      const cur = this.dtNode(node);
      const bit = this.getBit(keyBytes, cur.bitIndex);
      node = bit ? cur.rightRaw : cur.leftRaw;
    }

    const leaf = this.dtNode(node);
    const nameStringIndex = leaf.nameRaw & 0x7fffffff;
    if (!this.stringBytes(nameStringIndex).equals(keyBytes)) {
      return -1;
    }
    return node;
  }

  findMeta(key: string): [number, number] {
    const node = this.findNode(key);
    if (node < 0) {
      return [-1, -1];
    }
    const meta = this.dtNode(node).metaIndex;
    return [node, meta];
  }

  *iterEntries(): Generator<{ nodeIndex: number; node: DtNode; path: string }> {
    for (let nodeIndex = 1; nodeIndex < this.dtNodeCount; nodeIndex += 1) {
      const node = this.dtNode(nodeIndex);
      const nameStringIndex = node.nameRaw & 0x7fffffff;
      const pathText = this.stringBytes(nameStringIndex).toString("utf8");
      yield { nodeIndex, node, path: pathText };
    }
  }

  private ensureDatFd(): number {
    if (!this.datPath) {
      throw new Error("datPath is required for extraction");
    }
    if (this.datFd === null) {
      this.datFd = fs.openSync(this.datPath, "r");
    }
    return this.datFd;
  }

  private readRawMetaBytes(meta: MetaRecord): Buffer {
    if (meta.size === 0) {
      return Buffer.alloc(0);
    }
    if (meta.startBlock === 0xffffffff) {
      throw new Error("Invalid start block 0xFFFFFFFF");
    }

    const datFd = this.ensureDatFd();
    let remaining = meta.size;
    const out = Buffer.alloc(meta.size);
    let block = meta.startBlock;
    let outOff = 0;
    const blockCount = Math.floor((meta.size + 0x1ff) / 0x200);

    for (let i = 0; i < blockCount; i += 1) {
      const take = remaining >= 0x200 ? 0x200 : remaining;
      const datOff = block * 0x200;
      const bytesRead = fs.readSync(datFd, out, outOff, take, datOff);
      if (bytesRead !== take) {
        throw new Error(`Short DAT read at block ${block}: got ${bytesRead}, expected ${take}`);
      }

      outOff += take;
      remaining -= take;
      if (remaining <= 0) {
        break;
      }

      const nxt = this.fatNext(block);
      if (nxt === 0xffffffff) {
        throw new Error(`Unexpected end of FAT chain at block ${block}`);
      }
      block = nxt;
    }

    if (remaining !== 0) {
      throw new Error(`Unexpected extracted size ${meta.size - remaining} (expected ${meta.size})`);
    }
    return out;
  }

  decodeFilePayload(raw: Buffer): Buffer {
    if (raw.length < FILE_WRAPPER_HEADER_SIZE) {
      throw new Error(`Truncated wrapped file: ${raw.length} bytes (need >= ${FILE_WRAPPER_HEADER_SIZE})`);
    }

    const typ = readU32(raw, 0);
    const declaredSize = readU32(raw, 4);
    const payload = raw.subarray(FILE_WRAPPER_HEADER_SIZE);

    if (typ === 1) {
      const out = zlib.inflateSync(payload);
      if (declaredSize !== 0 && out.length !== declaredSize) {
        throw new Error(`Size mismatch: decoded=${out.length} declared=${declaredSize}`);
      }
      return out;
    }

    if (declaredSize !== 0 && payload.length !== declaredSize) {
      throw new Error(
        `Unsupported wrapper type=${typ} and size mismatch: payload=${payload.length} declared=${declaredSize}`
      );
    }
    return payload;
  }

  readFileBytes(metaIndex: number): Buffer {
    const meta = this.metaRecord(metaIndex);
    const raw = this.readRawMetaBytes(meta);
    return this.decodeFilePayload(raw);
  }

  extractTo(archivePath: string, outDir: string): void {
    const [, metaIndex] = this.findMeta(archivePath);
    if (metaIndex < 0) {
      throw new Error(`Not found: ${archivePath}`);
    }
    const dest = safeOutputPath(outDir, archivePath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, this.readFileBytes(metaIndex));
  }
}

export function safeOutputPath(outDir: string, archivePath: string): string {
  const rel = archivePath.replaceAll("\\", "/");
  const parts: string[] = [];
  for (const partRaw of rel.split("/")) {
    if (!partRaw || partRaw === "." || partRaw === "..") {
      continue;
    }
    let part = partRaw;
    if (part.includes(":")) {
      part = part.replaceAll(":", "_");
    }
    part = part.replace(/[<>:"|?*]/g, "_").replace(/[ .]+$/g, "");
    if (part.length > 200) {
      part = part.slice(0, 200);
    }
    if (part) {
      parts.push(part);
    }
  }

  if (parts.length === 0) {
    throw new Error(`empty path after sanitization: ${archivePath}`);
  }

  const dest = path.join(outDir, ...parts);
  const outAbs = path.resolve(outDir);
  const destAbs = path.resolve(dest);
  const outNorm = outAbs.endsWith(path.sep) ? outAbs : `${outAbs}${path.sep}`;
  if (!(destAbs === outAbs || destAbs.startsWith(outNorm))) {
    throw new Error(`refusing to write outside output dir: ${archivePath}`);
  }
  return dest;
}

export function winExtPath(p: string): string {
  const s = path.resolve(p);
  if (process.platform !== "win32") {
    return s;
  }
  if (s.startsWith("\\\\?\\")) {
    return s;
  }
  if (s.length < 248) {
    return s;
  }
  if (s.startsWith("\\\\")) {
    return `\\\\?\\UNC\\${s.replace(/^\\\\+/, "")}`;
  }
  return `\\\\?\\${s}`;
}

export function writeIdxChannelBytes(
  fd: number,
  idx: PriusIdx,
  channel: number,
  channelOffset: number,
  data: Buffer
): void {
  let off = channelOffset;
  let cursor = 0;
  while (cursor < data.length) {
    const fileOff = idx.channelOffsetToFileOffset(channel, off);
    const room = idx.pageSize - (off % idx.pageSize);
    const take = Math.min(room, data.length - cursor);
    const wrote = fs.writeSync(fd, data, cursor, take, fileOff);
    if (wrote !== take) {
      throw new Error(`Short IDX write at channel=${channel} off=${off}: wrote ${wrote}, expected ${take}`);
    }
    cursor += take;
    off += take;
  }
}

export function packMetaRecord(flags: number, size: number, startBlock: number, extra: number): Buffer {
  const out = Buffer.allocUnsafe(META_SIZE);
  out.writeUInt32LE(flags >>> 0, 0);
  out.writeUInt32LE(size >>> 0, 4);
  out.writeUInt32LE(startBlock >>> 0, 8);
  out.writeUInt32LE(extra >>> 0, 12);
  return out;
}

export function unpackMetaRecord(buf: Buffer, offset: number): MetaRecord {
  return {
    flags: readU32(buf, offset),
    size: readU32(buf, offset + 4),
    startBlock: readU32(buf, offset + 8),
    extra: readU32(buf, offset + 12)
  };
}

export function packU32(value: number): Buffer {
  return writeU32LE(value);
}
