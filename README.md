# PriusExtract

TypeScript/Node.js tools for extracting, repacking, and patching **Prius Online** game archives (`Prius.idx` + `Prius.dat`).

Traditional Chinese README: `README.zh-TW.md`

## Tools

| Script | Purpose |
|--------|---------|
| `src/cli/prius_extract_v2.ts` | Extract files, list contents, show archive info |
| `src/cli/prius_repack.ts` | Build a new idx+dat archive from a directory of files |
| `src/cli/prius_patch.ts` | Replace files in an existing idx+dat archive |
| `src/core/prius_archive.ts` | Shared archive library |

## Setup

```bash
npm install
```

## Source Layout

- `src/cli/`: thin CLI entrypoints (argument parsing + command dispatch)
- `src/repack/repack_engine.ts`: repack pipeline orchestration
- `src/repack/idx_writer.ts`: IDX striped-page writer
- `src/repack/string_table.ts`: string table builder
- `src/repack/patricia_trie.ts`: DT Patricia trie builder
- `src/repack/repack_jobs.ts`: worker-count selection + auto-tuning
- `src/patch/patch_engine.ts`: patch pipeline
- `src/extract/extract_files.ts`: `extract-all` and `extract-list`
- `src/extract/extract_compare.ts`: compare/report command
- `src/extract/extract_listing.ts`: listing/info/orphan commands
- `src/extract/extract_shared.ts`: shared extract helpers
- `src/core/`: shared runtime/archive/compression/filesystem helpers
- `src/workers/`: worker-thread runtime files

Build executable `.exe` files (Windows):

```bash
npm run build:exe
```

Output files:

- `bin/prius_extract_v2.exe`
- `bin/prius_repack.exe`
- `bin/prius_patch.exe`

`build:exe` currently uses `pkg` target `node18-win-x64` (embedded runtime in the executable).

## VSCode

- Run from **Terminal -> Run Task...** with:
  - `Prius: build TypeScript`
  - `Prius: build executables`
  - `Prius: extract (prompt args)`
  - `Prius: repack (prompt args)`
  - `Prius: patch (prompt args)`
- Debug/run from **Run and Debug** with:
  - `Prius Build TypeScript`
  - `Prius Build Executables`
  - `Prius Extract (prompt args)`
  - `Prius Repack (prompt args)`
  - `Prius Patch (prompt args)`
- Config files are included at:
  - `.vscode/tasks.json`
  - `.vscode/launch.json`

## Quick Start

### List all files in an archive

```bash
npx tsx src/cli/prius_extract_v2.ts --idx Prius.idx list-dt
```

### Get archive info (file count, channel sizes)

```bash
npx tsx src/cli/prius_extract_v2.ts --idx Prius.idx info
```

### Extract all files

```bash
npx tsx src/cli/prius_extract_v2.ts --idx Prius.idx --dat Prius.dat extract-all --out output/
```

Extract all files (continue on errors, skip already extracted files):

```bash
npx tsx src/cli/prius_extract_v2.ts --idx Prius.idx --dat Prius.dat extract-all \
    --out output/ --keep-going --skip-existing
```

### Extract specific files from a list

```bash
npx tsx src/cli/prius_extract_v2.ts --idx Prius.idx --dat Prius.dat extract-list \
    --full-list filelist.txt --out output/
```

Extract from list with missing/failed report:

```bash
npx tsx src/cli/prius_extract_v2.ts --idx Prius.idx --dat Prius.dat extract-list \
    --full-list filelist.txt --out output/ --report extract_report.tsv
```

`extract-list` also supports `--keep-going` and `--skip-existing` like `extract-all`.

### Repack all files into a new archive

```bash
npx tsx src/cli/prius_repack.ts --in-dir output/ --out-idx New.idx --out-dat New.dat
```

Repack with verification:

```bash
npx tsx src/cli/prius_repack.ts --in-dir output/ --out-idx New.idx --out-dat New.dat --verify
```

Repack with custom compression level (`1..9`, default `6`):

```bash
npx tsx src/cli/prius_repack.ts --in-dir output/ --out-idx New.idx --out-dat New.dat --compress-level 9
```

Repack with explicit worker count:

```bash
npx tsx src/cli/prius_repack.ts --in-dir output/ --out-idx New.idx --out-dat New.dat --jobs 8
```

Repack with optional worker auto-tuning on a sample set (useful when many small files):

```bash
npx tsx src/cli/prius_repack.ts --in-dir output/ --out-idx New.idx --out-dat New.dat --auto-tune-jobs
```

Enable large-file-first scheduling (opt-in):

```bash
npx tsx src/cli/prius_repack.ts --in-dir output/ --out-idx New.idx --out-dat New.dat --size-schedule
```

Repack only files from a provided archive path list:

```bash
npx tsx src/cli/prius_repack.ts --in-dir output/ --file-list filelist.txt \
    --out-idx New.idx --out-dat New.dat
```

### Patch files in an existing archive

Patch a single file:

```bash
npx tsx src/cli/prius_patch.ts --idx Prius.idx --dat Prius.dat \
    --file "texture\example.dds=replacement.dds"
```

Patch all files from a mod directory:

```bash
npx tsx src/cli/prius_patch.ts --idx Prius.idx --dat Prius.dat --patch-dir mods/
```

Patch with custom compression level (`1..9`, default `6`):

```bash
npx tsx src/cli/prius_patch.ts --idx Prius.idx --dat Prius.dat --patch-dir mods/ --compress-level 9
```

Patch with explicit worker count:

```bash
npx tsx src/cli/prius_patch.ts --idx Prius.idx --dat Prius.dat --patch-dir mods/ --jobs 8
```

Dry run (preview without modifying):

```bash
npx tsx src/cli/prius_patch.ts --idx Prius.idx --dat Prius.dat --patch-dir mods/ --dry-run
```

### Other commands

List orphan strings (paths in string table but not in the directory tree):

```bash
npx tsx src/cli/prius_extract_v2.ts --idx Prius.idx list-orphans
```

Compare archive contents against a full file list:

```bash
npx tsx src/cli/prius_extract_v2.ts --idx Prius.idx compare --full-list output_20101110.txt
```

Compare with TSV report output:

```bash
npx tsx src/cli/prius_extract_v2.ts --idx Prius.idx compare \
    --full-list output_20101110.txt --report compare_report.tsv
```

List only DT entries that map to actual file payloads (`meta.size > 0`):

```bash
npx tsx src/cli/prius_extract_v2.ts --idx Prius.idx list-dt --only-files
```

## Archive Format

### Overview

A Prius archive consists of two files:

- **`Prius.idx`** ??Index file containing the directory tree, string table, file metadata, and block allocation table
- **`Prius.dat`** ??Data file containing compressed file payloads stored in 512-byte blocks

### IDX Structure

The IDX file uses a **striped page layout** with page size `0x1000` (4096 bytes). The first page is the header; all remaining pages are interleaved across 4 channels in repeating stripes.

**Header** (first page):

| Offset | Type | Description |
|--------|------|-------------|
| 0x00 | char[4] | Magic: `ABCD` |
| 0x04 | u32 | Channel count (4) |
| 0x08 | u32 x2 | Channel 0: pages_per_stripe, size_bytes |
| 0x10 | u32 x2 | Channel 1: pages_per_stripe, size_bytes |
| 0x18 | u32 x2 | Channel 2: pages_per_stripe, size_bytes |
| 0x20 | u32 x2 | Channel 3: pages_per_stripe, size_bytes |

**Pages-per-stripe** (default): `(4, 8, 1, 4)` ??meaning in each stripe of 17 pages, Channel 0 gets 4 pages, Channel 1 gets 8, Channel 2 gets 1, and Channel 3 gets 4.

Physical page layout: `[Header] [S0:Ch0 x4] [S0:Ch1 x8] [S0:Ch2 x1] [S0:Ch3 x4] [S1:Ch0 x4] ...`

#### Channel 0 ??Directory Tree (DT)

A **Patricia trie** (radix tree) mapping file paths to metadata indices.

Each node is 20 bytes:

| Offset | Type | Description |
|--------|------|-------------|
| 0x00 | u32 | `meta_index` ??index into the meta table |
| 0x04 | s32 | `bit_index` ??bit position for branching (-1 for root) |
| 0x08 | u32 | `name_raw` ??string index OR'd with `0x80000000` |
| 0x0C | u32 | `left` ??node index for bit=0 |
| 0x10 | u32 | `right` ??node index for bit=1 |

Node 0 is the root sentinel (`bit_index=-1`). All real entries start from node 1. Back-edges (to nodes with lower or equal `bit_index`) indicate a leaf comparison point.

Path keys use **backslash** separators (e.g., `texture\example.dds`).

#### Channel 1 ??String Table

Stores file path strings as chained records of `0x40` (64) bytes each.

Each record:

| Offset | Type | Description |
|--------|------|-------------|
| 0x00 | u32 | Bit 31 = in-use flag (must be 1), bits 0-30 = next record index (0 = end of chain) |
| 0x04 | char[60] | String payload (NUL-terminated if last chunk) |

Record 0 is the root sentinel string `"."` (allocated with `0x80000000`). Long paths span multiple chained records.

#### Channel 2 ??Meta Table

File metadata records, 16 bytes each:

| Offset | Type | Description |
|--------|------|-------------|
| 0x00 | u32 | `flags` (1 = compressed) |
| 0x04 | u32 | `size` ??total wrapped payload size in bytes |
| 0x08 | u32 | `start_block` - first block index in the DAT file (block 0 is reserved) |
| 0x0C | u32 | `extra` (reserved, typically 0) |

#### Channel 3 ??FAT (File Allocation Table)

Block chain table, 4 bytes per entry:

| Offset | Type | Description |
|--------|------|-------------|
| 0x00 | u32 | Next block index, or `0xFFFFFFFF` = end of chain |

Each entry corresponds to a 512-byte block in the DAT file. Files spanning multiple blocks form a linked list through the FAT. FAT[0] is a reserved sentinel (0), so real file data starts at block 1.

### DAT Structure

The DAT file is a flat sequence of **512-byte blocks** (`0x200`). Each file's compressed payload is stored across one or more consecutive or chained blocks (linked via the FAT).

#### File Wrapper Header

Each file payload begins with a 32-byte (`0x20`) wrapper header:

| Offset | Type | Description |
|--------|------|-------------|
| 0x00 | u32 | Type: `1` = zlib compressed |
| 0x04 | u32 | Decompressed size |
| 0x08 | u64 | FILETIME timestamp 1 |
| 0x10 | u64 | FILETIME timestamp 2 |
| 0x18 | u64 | FILETIME timestamp 3 |

The wrapper header is followed by the zlib-compressed file data.

## Notes

- **Patching** appends new data to the DAT and updates the IDX metadata/FAT. Old blocks become dead space. Use a full repack to reclaim wasted space.
- **Patch safety**: the patcher validates DAT/FAT consistency before writing, preserves existing metadata fields, verifies patched content after writing, and auto-rolls back on failure.
- **Compression level**: `--compress-level` accepts `1..9` (`6` default). Higher values are slower with smaller output.
- **Parallel compression**: `repack` and `patch` use all CPU cores by default. Override with `--jobs <n>`. Packaged `.exe` builds run without external worker files and fall back to single-thread compression.
- **Scheduling**: repack uses default-order scheduling; use `--size-schedule` to enable large-file-first scheduling for mixed-size datasets.
- **Thread model**: parallel work uses worker threads (inside one process), so Task Manager may not show many separate processes.
- **Phase timing logs**: `repack`, `patch`, and extraction commands print per-phase elapsed time plus total elapsed runtime.
- **CLI input behavior**: `extract-all` and `extract-list` require `--dat`; metadata/list commands (`info`, `list-dt`, `list-orphans`, `compare`) work with `--idx` only.
- **Path matching**: patch resolves archive paths by exact key first, then lowercase fallback (useful when keys in archives are lowercase).
- **Repack path normalization**: repack lowercases archive keys; path collisions that differ only by case are deduplicated.
- **Orphan strings**: Some paths exist in the string table but have no DT node ??these are remnants from game updates and cannot be extracted.
- **Path case matters**: game lookups are case-sensitive at the DT leaf compare stage. Original archives use lowercase keys; repack normalizes archive keys to lowercase for compatibility.
- All tools require Node.js 18+ and npm dependencies installed (`npm install`).

## Disclaimer

This project was developed through static analysis of the Prius Online game client. Use at your own discretion.
If there are any copyright concerns, please contact us and this tool will be removed promptly.

## Development Tools

This project was developed using the following reverse engineering tools:
- [Ghidra 11.3.2](https://github.com/NationalSecurityAgency/ghidra)
- [GhidraMCP](https://github.com/LaurieWired/GhidraMCP)

## Development Notes

In the past, manual analysis took weeks without successfully clarifying the complete archive format.
Although it was possible to roughly understand the data layout and file structure, the specific details of the Patricia trie, striped page layout, and FAT chain could not be fully documented.
With LLM assistance, the archive format was fully reverse-engineered and a complete extract/repack/patch toolchain was built in just one week.

