import { DT_NODE_SIZE } from "../core/prius_archive.js";

interface TrieNode {
  metaIndex: number;
  bitIndex: number;
  nameRaw: number;
  leftRaw: number;
  rightRaw: number;
}

function getBit(key: Buffer, bitIndex: number): number {
  if (bitIndex < 0) {
    return 2;
  }
  const byteIndex = bitIndex >> 3;
  if (byteIndex >= key.length) {
    return 0;
  }
  return (key[byteIndex] >> (bitIndex & 7)) & 1;
}

function firstDifferingBit(a: Buffer, b: Buffer): number {
  const maxLen = Math.max(a.length, b.length);
  for (let byteIndex = 0; byteIndex < maxLen; byteIndex += 1) {
    const ba = byteIndex < a.length ? a[byteIndex] : 0;
    const bb = byteIndex < b.length ? b[byteIndex] : 0;
    if (ba !== bb) {
      const diff = ba ^ bb;
      for (let bit = 0; bit < 8; bit += 1) {
        if (diff & (1 << bit)) {
          return byteIndex * 8 + bit;
        }
      }
    }
  }
  return maxLen * 8;
}

export class PatriciaTrieBuilder {
  private readonly nodes: TrieNode[] = [
    { metaIndex: 0, bitIndex: -1, nameRaw: 0x80000000, leftRaw: 0, rightRaw: 0 }
  ];

  buildFromKeys(keys: Buffer[], stringIndices: number[], metaIndices: number[]): void {
    if (keys.length !== stringIndices.length || keys.length !== metaIndices.length) {
      throw new Error("keys/stringIndices/metaIndices length mismatch");
    }
    if (keys.length === 0) {
      return;
    }

    const keyData: Buffer[] = [Buffer.alloc(0)];

    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      const strIdx = stringIndices[i];
      const metaIdx = metaIndices[i];
      const nodeIdx = this.nodes.length;
      this.nodes.push({
        metaIndex: metaIdx,
        bitIndex: -1,
        nameRaw: (strIdx | 0x80000000) >>> 0,
        leftRaw: 0,
        rightRaw: 0
      });
      keyData.push(key);

      if (nodeIdx === 1) {
        const diffBit = firstDifferingBit(key, Buffer.alloc(0));
        this.nodes[nodeIdx].bitIndex = diffBit;
        if (getBit(key, diffBit) !== 0) {
          this.nodes[nodeIdx].leftRaw = 0;
          this.nodes[nodeIdx].rightRaw = nodeIdx;
        } else {
          this.nodes[nodeIdx].leftRaw = nodeIdx;
          this.nodes[nodeIdx].rightRaw = 0;
        }
        this.nodes[0].rightRaw = nodeIdx;
        continue;
      }

      let prev = 0;
      let curr = this.nodes[0].rightRaw;
      while (this.nodes[prev].bitIndex < this.nodes[curr].bitIndex) {
        prev = curr;
        curr = getBit(key, this.nodes[curr].bitIndex) !== 0 ? this.nodes[curr].rightRaw : this.nodes[curr].leftRaw;
      }

      const closestKey = keyData[curr];
      const diffBit = firstDifferingBit(key, closestKey);
      if (diffBit >= Math.max(key.length, closestKey.length) * 8) {
        throw new Error(`Duplicate key: ${key.toString("utf8")}`);
      }

      prev = 0;
      curr = this.nodes[0].rightRaw;
      while (this.nodes[prev].bitIndex < this.nodes[curr].bitIndex && this.nodes[curr].bitIndex < diffBit) {
        prev = curr;
        curr = getBit(key, this.nodes[curr].bitIndex) !== 0 ? this.nodes[curr].rightRaw : this.nodes[curr].leftRaw;
      }

      this.nodes[nodeIdx].bitIndex = diffBit;
      if (getBit(key, diffBit) !== 0) {
        this.nodes[nodeIdx].leftRaw = curr;
        this.nodes[nodeIdx].rightRaw = nodeIdx;
      } else {
        this.nodes[nodeIdx].leftRaw = nodeIdx;
        this.nodes[nodeIdx].rightRaw = curr;
      }

      const parentBit = this.nodes[prev].bitIndex;
      const goRight = parentBit < 0 ? true : getBit(key, parentBit) !== 0;
      if (goRight) {
        this.nodes[prev].rightRaw = nodeIdx;
      } else {
        this.nodes[prev].leftRaw = nodeIdx;
      }
    }
  }

  build(): Buffer {
    const out = Buffer.alloc(this.nodes.length * DT_NODE_SIZE);
    for (let i = 0; i < this.nodes.length; i += 1) {
      const n = this.nodes[i];
      const off = i * DT_NODE_SIZE;
      out.writeUInt32LE(n.metaIndex >>> 0, off);
      out.writeInt32LE(n.bitIndex, off + 4);
      out.writeUInt32LE(n.nameRaw >>> 0, off + 8);
      out.writeUInt32LE(n.leftRaw >>> 0, off + 12);
      out.writeUInt32LE(n.rightRaw >>> 0, off + 16);
    }
    return out;
  }

  get nodeCount(): number {
    return this.nodes.length;
  }
}
