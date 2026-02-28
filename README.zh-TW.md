# PriusExtract（繁體中文）

以 TypeScript/Node.js 撰寫的工具，用於解包、重打包與修補 **Prius守護之星Online** 遊戲封存檔（`Prius.idx` + `Prius.dat`）。

English README: `README.md`

## 工具

| 腳本 | 用途 |
|------|------|
| `src/cli/prius_extract_v2.ts` | 解壓檔案、列出內容、顯示封存資訊 |
| `src/cli/prius_repack.ts` | 從目錄重新建立新的 idx+dat 封存 |
| `src/cli/prius_patch.ts` | 取代既有 idx+dat 封存中的檔案 |
| `src/core/prius_archive.ts` | 共用封存函式庫 |

## 安裝

```bash
npm install
```

## 原始碼結構

- `src/cli/`: 精簡 CLI 入口（參數解析與指令分派）
- `src/repack/repack_engine.ts`: 重打包流程主控
- `src/repack/idx_writer.ts`: IDX 條紋頁面寫入器
- `src/repack/string_table.ts`: 字串表建構器
- `src/repack/patricia_trie.ts`: DT Patricia trie 建構器
- `src/repack/repack_jobs.ts`: 工作執行緒數量選擇與自動調校
- `src/patch/patch_engine.ts`: 修補流程主控
- `src/extract/extract_files.ts`: `extract-all` 與 `extract-list`
- `src/extract/extract_compare.ts`: compare/report 指令
- `src/extract/extract_listing.ts`: list/info/orphan 指令
- `src/extract/extract_shared.ts`: 解包共用輔助函式
- `src/core/`: 共用 runtime/archive/compression/filesystem 輔助函式
- `src/workers/`: worker thread 執行檔

建立 Windows 可執行檔（`.exe`）：

```bash
npm run build:exe
```

輸出檔案：

- `bin/prius_extract_v2.exe`
- `bin/prius_repack.exe`
- `bin/prius_patch.exe`

目前 `build:exe` 使用 `pkg` 目標 `node18-win-x64`（Node runtime 內嵌於可執行檔中）。

## VSCode

- 可從 **Terminal -> Run Task...** 執行：
  - `Prius: build TypeScript`
  - `Prius: build executables`
  - `Prius: extract (prompt args)`
  - `Prius: repack (prompt args)`
  - `Prius: patch (prompt args)`
- 可從 **Run and Debug** 執行：
  - `Prius Build TypeScript`
  - `Prius Build Executables`
  - `Prius Extract (prompt args)`
  - `Prius Repack (prompt args)`
  - `Prius Patch (prompt args)`
- 設定檔位置：
  - `.vscode/tasks.json`
  - `.vscode/launch.json`

## 快速開始

### 列出封存中的所有檔案

```bash
npx tsx src/cli/prius_extract_v2.ts --idx Prius.idx list-dt
```

### 取得封存資訊（檔案數、channel 大小）

```bash
npx tsx src/cli/prius_extract_v2.ts --idx Prius.idx info
```

### 解壓全部檔案

```bash
npx tsx src/cli/prius_extract_v2.ts --idx Prius.idx --dat Prius.dat extract-all --out output/
```

解壓全部檔案（遇錯繼續、跳過已存在檔案）：

```bash
npx tsx src/cli/prius_extract_v2.ts --idx Prius.idx --dat Prius.dat extract-all \
    --out output/ --keep-going --skip-existing
```

### 依清單解壓指定檔案

```bash
npx tsx src/cli/prius_extract_v2.ts --idx Prius.idx --dat Prius.dat extract-list \
    --full-list filelist.txt --out output/
```

依清單解壓，並輸出缺失/失敗報告：

```bash
npx tsx src/cli/prius_extract_v2.ts --idx Prius.idx --dat Prius.dat extract-list \
    --full-list filelist.txt --out output/ --report extract_report.tsv
```

`extract-list` 也支援和 `extract-all` 相同的 `--keep-going` 與 `--skip-existing`。

### 重打包全部檔案為新封存

```bash
npx tsx src/cli/prius_repack.ts --in-dir output/ --out-idx New.idx --out-dat New.dat
```

重打包並驗證：

```bash
npx tsx src/cli/prius_repack.ts --in-dir output/ --out-idx New.idx --out-dat New.dat --verify
```

自訂壓縮等級（`1..9`，預設 `6`）：

```bash
npx tsx src/cli/prius_repack.ts --in-dir output/ --out-idx New.idx --out-dat New.dat --compress-level 9
```

指定 worker 數量：

```bash
npx tsx src/cli/prius_repack.ts --in-dir output/ --out-idx New.idx --out-dat New.dat --jobs 8
```

對樣本檔案啟用 worker 自動調校（大量小檔案時有幫助）：

```bash
npx tsx src/cli/prius_repack.ts --in-dir output/ --out-idx New.idx --out-dat New.dat --auto-tune-jobs
```

啟用大檔優先排程（選用）：

```bash
npx tsx src/cli/prius_repack.ts --in-dir output/ --out-idx New.idx --out-dat New.dat --size-schedule
```

僅打包清單中列出的封存路徑：

```bash
npx tsx src/cli/prius_repack.ts --in-dir output/ --file-list filelist.txt \
    --out-idx New.idx --out-dat New.dat
```

### 修補既有封存中的檔案

修補單一檔案：

```bash
npx tsx src/cli/prius_patch.ts --idx Prius.idx --dat Prius.dat \
    --file "texture\example.dds=replacement.dds"
```

從 mod 目錄修補全部檔案：

```bash
npx tsx src/cli/prius_patch.ts --idx Prius.idx --dat Prius.dat --patch-dir mods/
```

自訂壓縮等級（`1..9`，預設 `6`）：

```bash
npx tsx src/cli/prius_patch.ts --idx Prius.idx --dat Prius.dat --patch-dir mods/ --compress-level 9
```

指定 worker 數量：

```bash
npx tsx src/cli/prius_patch.ts --idx Prius.idx --dat Prius.dat --patch-dir mods/ --jobs 8
```

乾跑模式（只預覽，不修改）：

```bash
npx tsx src/cli/prius_patch.ts --idx Prius.idx --dat Prius.dat --patch-dir mods/ --dry-run
```

### 其他指令

列出孤兒字串（存在於字串表但不在目錄樹中）：

```bash
npx tsx src/cli/prius_extract_v2.ts --idx Prius.idx list-orphans
```

將封存內容與完整檔案清單比較：

```bash
npx tsx src/cli/prius_extract_v2.ts --idx Prius.idx compare --full-list output_20101110.txt
```

比較並輸出 TSV 報告：

```bash
npx tsx src/cli/prius_extract_v2.ts --idx Prius.idx compare \
    --full-list output_20101110.txt --report compare_report.tsv
```

只列出對應實際檔案資料的 DT 項目（`meta.size > 0`）：

```bash
npx tsx src/cli/prius_extract_v2.ts --idx Prius.idx list-dt --only-files
```

## 封存格式

### 概觀

一個 Prius 封存由兩個檔案組成：

- **`Prius.idx`**：索引檔，包含目錄樹、字串表、檔案中繼資料與區塊配置表
- **`Prius.dat`**：資料檔，以 512-byte 區塊儲存壓縮後的檔案內容

### IDX 結構

IDX 使用 **條紋頁面（striped page）** 版面，頁面大小為 `0x1000`（4096 bytes）。第一頁為檔頭，其餘頁面以固定條紋規則交錯到 4 個 channel。

**檔頭**（第一頁）：

| Offset | Type | 說明 |
|--------|------|------|
| 0x00 | char[4] | 魔術字：`ABCD` |
| 0x04 | u32 | Channel 數量（4） |
| 0x08 | u32 x2 | Channel 0：pages_per_stripe, size_bytes |
| 0x10 | u32 x2 | Channel 1：pages_per_stripe, size_bytes |
| 0x18 | u32 x2 | Channel 2：pages_per_stripe, size_bytes |
| 0x20 | u32 x2 | Channel 3：pages_per_stripe, size_bytes |

**Pages-per-stripe**（預設）：`(4, 8, 1, 4)`，意即每個 17 頁的 stripe 中，Channel 0 佔 4 頁、Channel 1 佔 8 頁、Channel 2 佔 1 頁、Channel 3 佔 4 頁。

實體頁面布局：`[Header] [S0:Ch0 x4] [S0:Ch1 x8] [S0:Ch2 x1] [S0:Ch3 x4] [S1:Ch0 x4] ...`

#### Channel 0：Directory Tree（DT）

使用 **Patricia trie**（radix tree）將檔案路徑映射到 metadata index。

每個節點 20 bytes：

| Offset | Type | 說明 |
|--------|------|------|
| 0x00 | u32 | `meta_index`：meta 表索引 |
| 0x04 | s32 | `bit_index`：分支使用的 bit 位置（root 為 -1） |
| 0x08 | u32 | `name_raw`：字串索引，並 OR `0x80000000` |
| 0x0C | u32 | `left`：bit=0 的節點索引 |
| 0x10 | u32 | `right`：bit=1 的節點索引 |

節點 0 為 root sentinel（`bit_index=-1`）。真實項目由節點 1 開始。回邊（指向 `bit_index` 較小或相等的節點）代表葉節點比較點。

路徑鍵值使用 **反斜線** 分隔（例如：`texture\example.dds`）。

#### Channel 1：String Table

以鏈結記錄儲存路徑字串，每筆記錄大小為 `0x40`（64）bytes。

每筆記錄：

| Offset | Type | 說明 |
|--------|------|------|
| 0x00 | u32 | bit31=已使用旗標（必須為 1），bit0-30=下一筆索引（0=鏈結結束） |
| 0x04 | char[60] | 字串資料（若為最後一段，會有 NUL 結尾） |

記錄 0 為 root sentinel 字串 `"."`（配置為 `0x80000000`）。長路徑會分散在多筆鏈結記錄。

#### Channel 2：Meta Table

檔案 metadata 記錄，每筆 16 bytes：

| Offset | Type | 說明 |
|--------|------|------|
| 0x00 | u32 | `flags`（1=已壓縮） |
| 0x04 | u32 | `size`：包裝後 payload 總長度（bytes） |
| 0x08 | u32 | `start_block`：DAT 起始區塊索引（區塊 0 保留） |
| 0x0C | u32 | `extra`（保留欄位，通常為 0） |

#### Channel 3：FAT（File Allocation Table）

區塊鏈結表，每筆 4 bytes：

| Offset | Type | 說明 |
|--------|------|------|
| 0x00 | u32 | 下一個區塊索引，或 `0xFFFFFFFF`（鏈結結束） |

每筆 FAT 對應 DAT 中一個 512-byte 區塊。跨多區塊檔案會透過 FAT 形成鏈結。FAT[0] 為保留 sentinel（0），實際檔案資料由區塊 1 開始。

### DAT 結構

DAT 是由 **512-byte 區塊**（`0x200`）組成的平面資料序列。每個檔案的壓縮 payload 會儲存在一個或多個連續/鏈結區塊中（由 FAT 串接）。

#### 檔案包裝標頭（File Wrapper Header）

每個檔案 payload 開頭為 32-byte（`0x20`）包裝標頭：

| Offset | Type | 說明 |
|--------|------|------|
| 0x00 | u32 | 型別：`1` = zlib 壓縮 |
| 0x04 | u32 | 解壓後大小 |
| 0x08 | u64 | FILETIME 時戳 1 |
| 0x10 | u64 | FILETIME 時戳 2 |
| 0x18 | u64 | FILETIME 時戳 3 |

包裝標頭後面接 zlib 壓縮資料。

## 備註

- **Patch 行為**：修補會把新資料附加到 DAT，並更新 IDX 的 metadata/FAT。舊區塊會變成無效空間。若要回收空間，請執行完整 repack。
- **Patch 安全性**：寫入前會驗證 DAT/FAT 一致性、保留既有 metadata 欄位、寫入後驗證內容，失敗時自動回滾。
- **壓縮等級**：`--compress-level` 支援 `1..9`（預設 `6`）。等級越高，速度越慢、輸出通常越小。
- **平行壓縮**：`repack` 與 `patch` 預設使用所有 CPU 核心，可用 `--jobs <n>` 覆蓋。封裝後的 `.exe` 不需要外部 worker 檔，會自動回退為單執行緒壓縮。
- **排程模式**：repack 預設按原始順序排程；可用 `--size-schedule` 啟用大檔優先排程，對混合大小資料集可能較有利。
- **執行緒模型**：平行工作使用 worker threads（同一個程序內），因此工作管理員不一定會看到很多獨立程序。
- **階段耗時日誌**：`repack`、`patch` 與 extract 指令會輸出每個 phase 的耗時與總耗時。
- **CLI 輸入行為**：`extract-all` 與 `extract-list` 必須提供 `--dat`；僅 metadata/list 類指令（`info`、`list-dt`、`list-orphans`、`compare`）可只用 `--idx`。
- **路徑比對**：patch 會先嘗試精確鍵值，再嘗試小寫回退（有助於原封存使用小寫鍵值時）。
- **repack 路徑正規化**：repack 會將封存鍵值轉成小寫；僅大小寫不同的路徑衝突會被去重。
- **孤兒字串**：部分路徑存在於字串表但沒有 DT 節點，通常是遊戲更新留下的殘留，無法解壓。
- **路徑大小寫很重要**：遊戲在 DT 葉節點比較階段是區分大小寫的。原始封存多使用小寫鍵值；repack 也會轉成小寫以提升相容性。
- 所有工具需要 Node.js 18+ 且已安裝 npm 相依套件（`npm install`）。

## 免責聲明

本專案是透過靜態分析 Prius Online 遊戲客戶端所開發，若有任何疑慮請勿使用。
若有任何侵權疑慮，請聯絡我們，我們將盡快移除此工具。

## 開發工具

此專案使用以下工具進行逆向工程：
- [Ghidra 11.3.2](https://github.com/NationalSecurityAgency/ghidra)
- [GhidraMCP](https://github.com/LaurieWired/GhidraMCP)

## 開發心得

過去透過人工分析，即使花費數週時間也無法完全理清封存格式。
雖然能大致了解資料布局與檔案結構，但 Patricia trie、條紋頁面配置與 FAT 鏈結等具體細節無法完整記錄。
在 LLM 的輔助下，僅花費一週就成功完成封存格式的完整逆向工程，並建立了完整的解包／重打包／修補工具鏈。
