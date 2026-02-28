import fs from "node:fs";
import path from "node:path";

export function walkFilesSorted(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];

  while (stack.length > 0) {
    const cur = stack.pop()!;
    const entries = fs
      .readdirSync(cur, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      const abs = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile()) {
        out.push(abs);
      }
    }
  }

  out.sort((a, b) => a.localeCompare(b, "en"));
  return out;
}

export async function statFileSizes(paths: string[], concurrencyHint: number): Promise<number[]> {
  const sizes = new Array<number>(paths.length);
  if (paths.length === 0) {
    return sizes;
  }

  const workers = Math.max(1, Math.min(paths.length, Math.max(4, concurrencyHint * 4, 16)));
  let next = 0;
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (true) {
        const idx = next;
        next += 1;
        if (idx >= paths.length) {
          return;
        }
        try {
          const st = await fs.promises.stat(paths[idx]);
          sizes[idx] = st.isFile() ? st.size : 0;
        } catch {
          sizes[idx] = 0;
        }
      }
    })
  );
  return sizes;
}
