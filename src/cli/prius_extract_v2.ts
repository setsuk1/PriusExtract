import { elapsedSince, isMainModule } from "../core/prius_runtime.js";
import { cmdCompare, cmdExtractAll, cmdExtractList, cmdInfo, cmdListDt, cmdListOrphans } from "../extract/extract_commands.js";

function usage(): void {
  console.log(
    [
      "Prius archive extractor v2 (DT-based)",
      "",
      "Global usage:",
      "  tsx src/cli/prius_extract_v2.ts --idx <idx> [--dat <dat>] <command> [options]",
      "",
      "Commands:",
      "  info",
      "  extract-all --out <dir> [--keep-going] [--skip-existing]",
      "  extract-list --full-list <file> --out <dir> [--keep-going] [--skip-existing] [--report <file>]",
      "  list-dt [--only-files]",
      "  list-orphans",
      "  compare --full-list <file> [--report <file>]",
      "",
      "Examples:",
      "  tsx src/cli/prius_extract_v2.ts --idx Prius.idx info",
      "  tsx src/cli/prius_extract_v2.ts --idx Prius.idx --dat Prius.dat extract-all --out output",
      "  tsx src/cli/prius_extract_v2.ts --idx Prius.idx compare --full-list output_20101110.txt"
    ].join("\n")
  );
}

function parseBoolFlag(argv: string[], i: number, flag: string): [boolean, number] {
  if (argv[i] === flag) {
    return [true, i + 1];
  }
  return [false, i];
}

function parseValue(argv: string[], i: number, name: string): [string, number] {
  if (i + 1 >= argv.length) {
    throw new Error(`Missing value for ${name}`);
  }
  return [argv[i + 1], i + 2];
}

function main(argv = process.argv.slice(2)): number {
  try {
    if (argv.length === 0) {
      usage();
      return 1;
    }

    let idx: string | null = null;
    let dat: string | null = null;
    let i = 0;
    while (i < argv.length && argv[i].startsWith("-")) {
      const a = argv[i];
      if (a === "-h" || a === "--help") {
        usage();
        return 0;
      }
      if (a === "--idx") {
        [idx, i] = parseValue(argv, i, a);
      } else if (a === "--dat") {
        [dat, i] = parseValue(argv, i, a);
      } else {
        throw new Error(`Unknown global argument: ${a}`);
      }
    }

    if (!idx) {
      throw new Error("--idx is required");
    }
    if (i >= argv.length) {
      throw new Error("Missing command");
    }

    const cmd = argv[i];
    const rest = argv.slice(i + 1);
    const commandStart = process.hrtime.bigint();
    const finish = (code: number): number => {
      console.log(`\nTotal elapsed: ${elapsedSince(commandStart)}`);
      return code;
    };

    switch (cmd) {
      case "info":
        return finish(cmdInfo(idx, dat));
      case "list-dt": {
        let onlyFiles = false;
        let j = 0;
        while (j < rest.length) {
          if (rest[j] === "--only-files") {
            onlyFiles = true;
            j += 1;
          } else {
            throw new Error(`Unknown option for list-dt: ${rest[j]}`);
          }
        }
        return finish(cmdListDt(idx, dat, onlyFiles));
      }
      case "list-orphans":
        if (rest.length > 0) {
          throw new Error(`Unknown option for list-orphans: ${rest[0]}`);
        }
        return finish(cmdListOrphans(idx, dat));
      case "compare": {
        let fullList: string | null = null;
        let report: string | null = null;
        let j = 0;
        while (j < rest.length) {
          if (rest[j] === "--full-list") {
            [fullList, j] = parseValue(rest, j, "--full-list");
          } else if (rest[j] === "--report") {
            [report, j] = parseValue(rest, j, "--report");
          } else {
            throw new Error(`Unknown option for compare: ${rest[j]}`);
          }
        }
        if (!fullList) {
          throw new Error("--full-list is required for compare");
        }
        return finish(cmdCompare(idx, dat, fullList, report));
      }
      case "extract-all": {
        if (!dat) {
          throw new Error("--dat is required for extract-all");
        }
        let out: string | null = null;
        let keepGoing = false;
        let skipExisting = false;
        let j = 0;
        while (j < rest.length) {
          if (rest[j] === "--out") {
            [out, j] = parseValue(rest, j, "--out");
          } else if (rest[j] === "--keep-going") {
            [keepGoing, j] = parseBoolFlag(rest, j, "--keep-going");
          } else if (rest[j] === "--skip-existing") {
            [skipExisting, j] = parseBoolFlag(rest, j, "--skip-existing");
          } else {
            throw new Error(`Unknown option for extract-all: ${rest[j]}`);
          }
        }
        if (!out) {
          throw new Error("--out is required for extract-all");
        }
        return finish(cmdExtractAll(idx, dat, out, keepGoing, skipExisting));
      }
      case "extract-list": {
        if (!dat) {
          throw new Error("--dat is required for extract-list");
        }
        let fullList: string | null = null;
        let out: string | null = null;
        let keepGoing = false;
        let skipExisting = false;
        let report: string | null = null;
        let j = 0;
        while (j < rest.length) {
          if (rest[j] === "--full-list") {
            [fullList, j] = parseValue(rest, j, "--full-list");
          } else if (rest[j] === "--out") {
            [out, j] = parseValue(rest, j, "--out");
          } else if (rest[j] === "--keep-going") {
            [keepGoing, j] = parseBoolFlag(rest, j, "--keep-going");
          } else if (rest[j] === "--skip-existing") {
            [skipExisting, j] = parseBoolFlag(rest, j, "--skip-existing");
          } else if (rest[j] === "--report") {
            [report, j] = parseValue(rest, j, "--report");
          } else {
            throw new Error(`Unknown option for extract-list: ${rest[j]}`);
          }
        }
        if (!fullList || !out) {
          throw new Error("--full-list and --out are required for extract-list");
        }
        return finish(cmdExtractList(idx, dat, fullList, out, keepGoing, skipExisting, report));
      }
      default:
        throw new Error(`Unknown command: ${cmd}`);
    }
  } catch (e) {
    console.error(`ERROR: ${String(e)}`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  process.exit(main());
}
