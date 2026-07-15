#!/usr/bin/env node
// Set every package to <version> in one atomic step so the three things that
// must stay in lockstep never drift: each package.json `version`, the internal
// `@wirelessr/pi-webui-components` dependency ranges, and package-lock.json.
// (Bumping only `version` by hand — leaving the `^old` range and a stale lock —
// breaks the workspace link and makes `npm ci` 404 on the registry.)
//
// Usage: node scripts/set-version.mjs <x.y.z>

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version || "")) {
  console.error("usage: node scripts/set-version.mjs <x.y.z>");
  process.exit(1);
}

const INTERNAL = "@wirelessr/pi-webui-components";
const files = [
  "package.json",
  "packages/components/package.json",
  "packages/extension/package.json",
  "packages/hub/package.json",
];

for (const f of files) {
  const pkg = JSON.parse(readFileSync(f, "utf8"));
  pkg.version = version;
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    if (pkg[field]?.[INTERNAL]) pkg[field][INTERNAL] = `^${version}`;
  }
  writeFileSync(f, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`  set ${f} -> ${version}`);
}

// Sync the lockfile to the new versions/ranges (no node_modules churn).
execSync("npm install --package-lock-only", { stdio: "inherit" });
console.log(`set-version: all packages at ${version}, lockfile synced`);
