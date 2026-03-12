#!/usr/bin/env bun
import { chmodSync, copyFileSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";

function main() {
  const projectRoot = resolve(import.meta.dir, "..");
  const src = resolve(projectRoot, "dist", "ccs");

  const destDir = resolve(homedir(), ".local", "bin");
  const dest = resolve(destDir, "ccs");

  mkdirSync(destDir, { recursive: true });
  copyFileSync(src, dest);
  chmodSync(dest, 0o755);

  // Basic sanity check that we copied a file
  const size = statSync(dest).size;
  if (size <= 0) {
    throw new Error(`installed binary has unexpected size: ${dest}`);
  }

  console.log(`Installed ${basename(dest)} -> ${dest}`);
}

main();

