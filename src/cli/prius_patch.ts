import fs from "node:fs";
import path from "node:path";
import { patchFiles } from "../patch/patch_engine.js";
import { walkFilesSorted } from "../core/fs_walk.js";
import { defaultJobs, isMainModule } from "../core/prius_runtime.js";

interface CliArgs {
  idx: string;
  dat: string;
  files: string[];
  patchDir: string | null;
  compressLevel: number;
  dryRun: boolean;
  jobs: number;
}

function usage(): void {
  console.log(
    [
      "Patch files in an existing Prius.idx + Prius.dat archive",
      "",
      "Usage:",
      "  tsx src/cli/prius_patch.ts --idx <idx> --dat <dat> [--file arc=local] [--patch-dir dir] [options]",
      "",
      "Options:",
      "  --file <arc=local>      Patch one file mapping (repeatable)",
      "  --patch-dir <dir>       Patch from directory tree",
      "  --compress-level <1-9>  zlib compression level (default: 6)",
      "  --jobs <n>              Parallel compression workers (default: all CPU cores)",
      "  --dry-run               Show what would be patched without modifying files",
      "  -h, --help              Show this help"
    ].join("\n")
  );
}

function parseCli(argv: string[]): CliArgs {
  let idx: string | null = null;
  let dat: string | null = null;
  const files: string[] = [];
  let patchDir: string | null = null;
  let compressLevel = 6;
  let dryRun = false;
  let jobs = defaultJobs();

  const needValue = (i: number, name: string): string => {
    if (i + 1 >= argv.length) {
      throw new Error(`Missing value for ${name}`);
    }
    return argv[i + 1];
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case "-h":
      case "--help":
        usage();
        process.exit(0);
      case "--idx":
        idx = needValue(i, a);
        i += 1;
        break;
      case "--dat":
        dat = needValue(i, a);
        i += 1;
        break;
      case "--file":
        files.push(needValue(i, a));
        i += 1;
        break;
      case "--patch-dir":
        patchDir = needValue(i, a);
        i += 1;
        break;
      case "--compress-level": {
        const raw = needValue(i, a);
        i += 1;
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1 || n > 9) {
          throw new Error(`Invalid --compress-level: ${raw} (expected integer 1..9)`);
        }
        compressLevel = n;
        break;
      }
      case "--dry-run":
        dryRun = true;
        break;
      case "--jobs": {
        const raw = needValue(i, a);
        i += 1;
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1) {
          throw new Error(`Invalid --jobs: ${raw} (expected integer >= 1)`);
        }
        jobs = n;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }

  if (!idx || !dat) {
    throw new Error("Missing required arguments: --idx, --dat");
  }
  return { idx, dat, files, patchDir, compressLevel, dryRun, jobs };
}

async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const args = parseCli(argv);
    const fileMap = new Map<string, string>();

    for (const spec of args.files) {
      const eq = spec.indexOf("=");
      if (eq < 0) {
        throw new Error(`--file must be 'archive_path=local_path', got: ${spec}`);
      }
      const arcPath = spec.slice(0, eq).trim();
      const localPath = spec.slice(eq + 1).trim();
      if (!fs.existsSync(localPath) || !fs.statSync(localPath).isFile()) {
        throw new Error(`Local file not found: ${localPath}`);
      }
      fileMap.set(arcPath, localPath);
    }

    if (args.patchDir) {
      const patchRoot = path.resolve(args.patchDir);
      if (!fs.existsSync(patchRoot) || !fs.statSync(patchRoot).isDirectory()) {
        throw new Error(`Patch directory not found: ${args.patchDir}`);
      }
      for (const abs of walkFilesSorted(patchRoot)) {
        const rel = path.relative(patchRoot, abs);
        const arcPath = rel.replaceAll(path.sep, "\\");
        fileMap.set(arcPath, abs);
      }
    }

    if (fileMap.size === 0) {
      throw new Error("No files to patch. Use --file or --patch-dir.");
    }

    console.log(`Files to patch: ${fileMap.size}`);
    const stats = await patchFiles(args.idx, args.dat, fileMap, args.compressLevel, args.dryRun, args.jobs);
    return stats.errors === 0 ? 0 : 1;
  } catch (e) {
    console.error(`ERROR: ${String(e)}`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  void main().then((code) => {
    process.exit(code);
  });
}
