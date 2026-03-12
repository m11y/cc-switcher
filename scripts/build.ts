#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

function runOrThrow(cmd: string[], cwd: string) {
  const proc = Bun.spawnSync({
    cmd,
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`command failed (exit ${proc.exitCode}): ${cmd.join(" ")}`);
  }
}

function main() {
  const projectRoot = resolve(import.meta.dir, "..");
  const distDir = resolve(projectRoot, "dist");
  const outFile = resolve(distDir, "ccs");
  const entry = resolve(projectRoot, "src", "cli.ts");

  mkdirSync(distDir, { recursive: true });

  // Compile binary
  runOrThrow([process.execPath, "build", entry, "--compile", "--outfile", outFile], projectRoot);

  // Install to ~/.local/bin/ccs
  runOrThrow([process.execPath, "run", resolve(projectRoot, "scripts", "install.ts")], projectRoot);
}

main();

