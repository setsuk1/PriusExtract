const STRING_RECORD_SIZE = 0x40;
const STRING_PAYLOAD_SIZE = 0x3c;

export class StringTableBuilder {
  private readonly records: Buffer[] = [];
  private readonly cache = new Map<string, number>();

  constructor() {
    const rec0 = Buffer.alloc(STRING_RECORD_SIZE);
    rec0.writeUInt32LE(0x80000000, 0);
    rec0[4] = 0x2e; // "."
    rec0[5] = 0x00;
    this.records.push(rec0);
  }

  add(text: Buffer, cacheKey: string): number {
    if (text.length === 0) {
      return 0;
    }
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const chunks: Buffer[] = [];
    for (let i = 0; i < text.length; i += STRING_PAYLOAD_SIZE) {
      chunks.push(text.subarray(i, i + STRING_PAYLOAD_SIZE));
    }

    const firstIdx = this.records.length;
    for (let i = 0; i < chunks.length; i += 1) {
      const isLast = i === chunks.length - 1;
      const nextIdx = isLast ? 0 : firstIdx + i + 1;
      const rec = Buffer.alloc(STRING_RECORD_SIZE);
      rec.writeUInt32LE((nextIdx | 0x80000000) >>> 0, 0);
      chunks[i].copy(rec, 4);
      this.records.push(rec);
    }

    this.cache.set(cacheKey, firstIdx);
    return firstIdx;
  }

  build(): Buffer {
    return Buffer.concat(this.records);
  }

  get recordCount(): number {
    return this.records.length;
  }
}
