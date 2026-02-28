import fs from "node:fs";
import { repack } from "../repack/repack_engine.js";
import { isMainModule } from "../core/prius_runtime.js";

interface CliArgs {
  inDir: string;
  outIdx: string;
  outDat: string;
  fileList: string | null;
  compressLevel: number;
  verify: boolean;
  jobs: number | null;
  autoTuneJobs: boolean;
  sizeSchedule: boolean;
}

function usage(): void {
  console.log(
    [
      "Prius archive repacker",
      "",
      "Usage:",
      "  tsx src/cli/prius_repack.ts --in-dir <dir> --out-idx <idx> --out-dat <dat> [options]",
      "",
      "Options:",
      "  --file-list <path>      Optional list of archive paths to include",
      "  --compress-level <1-9>  zlib compression level (default: 6)",
      "  --jobs <n>              Parallel compression workers (default: logical CPU count)",
      "  --auto-tune-jobs        Benchmark sample files to pick a worker count (opt-in)",
      "  --size-schedule         Enable large-file-first scheduling (opt-in)",
      "  --verify                Verify round-trip after repacking",
      "  -h, --help              Show this help"
    ].join("\n")
  );
}

function parseCli(argv: string[]): CliArgs {
  let inDir: string | null = null;
  let outIdx: string | null = null;
  let outDat: string | null = null;
  let fileList: string | null = null;
  let compressLevel = 6;
  let verify = false;
  let jobs: number | null = null;
  let autoTuneJobs = false;
  let sizeSchedule = false;

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
      case "--in-dir":
        inDir = needValue(i, a);
        i += 1;
        break;
      case "--out-idx":
        outIdx = needValue(i, a);
        i += 1;
        break;
      case "--out-dat":
        outDat = needValue(i, a);
        i += 1;
        break;
      case "--file-list":
        fileList = needValue(i, a);
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
      case "--verify":
        verify = true;
        break;
      case "--auto-tune-jobs":
        autoTuneJobs = true;
        break;
      case "--size-schedule":
        sizeSchedule = true;
        break;
      case "--no-size-schedule":
        sizeSchedule = false;
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

  if (!inDir || !outIdx || !outDat) {
    throw new Error("Missing required arguments: --in-dir, --out-idx, --out-dat");
  }
  return { inDir, outIdx, outDat, fileList, compressLevel, verify, jobs, autoTuneJobs, sizeSchedule };
}

async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const args = parseCli(argv);
    let fileList: string[] | null = null;
    if (args.fileList) {
      fileList = fs
        .readFileSync(args.fileList, "utf8")
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }

    const stats = await repack(
      args.inDir,
      args.outIdx,
      args.outDat,
      fileList,
      args.compressLevel,
      args.verify,
      5000,
      args.jobs,
      args.autoTuneJobs,
      args.sizeSchedule
    );
    return (stats.verifyErrors ?? 0) === 0 ? 0 : 1;
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
