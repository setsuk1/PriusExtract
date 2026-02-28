import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const buildDir = path.join(projectRoot, "build");
const binDir = path.join(projectRoot, "bin");

const targets = [
  {
    entry: path.join(projectRoot, "src", "cli", "prius_extract_v2.ts"),
    bundled: path.join(buildDir, "prius_extract_v2.cjs"),
    exe: path.join(binDir, "prius_extract_v2.exe")
  },
  {
    entry: path.join(projectRoot, "src", "cli", "prius_repack.ts"),
    bundled: path.join(buildDir, "prius_repack.cjs"),
    exe: path.join(binDir, "prius_repack.exe")
  },
  {
    entry: path.join(projectRoot, "src", "cli", "prius_patch.ts"),
    bundled: path.join(buildDir, "prius_patch.cjs"),
    exe: path.join(binDir, "prius_patch.exe")
  }
];

function run(command, args) {
  const status = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
    shell: process.platform === "win32"
  }).status;
  if (status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

async function main() {
  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  // Legacy sidecar cleanup: packaged executables now run without external worker files.
  for (const stale of [
    path.join(buildDir, "prius_parallel_worker.mjs"),
    path.join(binDir, "prius_parallel_worker.mjs")
  ]) {
    if (fs.existsSync(stale)) {
      fs.rmSync(stale, { force: true });
    }
  }

  for (const target of targets) {
    if (fs.existsSync(target.exe)) {
      fs.rmSync(target.exe, { force: true });
    }
  }

  for (const target of targets) {
    await build({
      entryPoints: [target.entry],
      outfile: target.bundled,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      sourcemap: false,
      logLevel: "info"
    });
  }

  const pkgCmd = process.platform === "win32" ? "npx.cmd" : "npx";
  for (const target of targets) {
    run(pkgCmd, ["pkg", target.bundled, "--targets", "node18-win-x64", "--output", target.exe]);
  }
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
