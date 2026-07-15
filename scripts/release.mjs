#!/usr/bin/env node
// One-command local release: bump every package (version + internal dep ranges
// + lockfile) atomically, run the suite, then commit and tag. Push with
// `git push origin main --follow-tags` to trigger the release workflow, which
// builds and publishes the flat extension to the `release` branch.
//
// Usage: node scripts/release.mjs <x.y.z>

import { execSync } from "node:child_process";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version || "")) {
  console.error("usage: npm run release <x.y.z>");
  process.exit(1);
}

const run = (cmd) => execSync(cmd, { stdio: "inherit" });

// Refuse to release from a dirty tree — the release commit must contain only
// the version bump.
const dirty = execSync("git status --porcelain", { encoding: "utf8" }).trim();
if (dirty) {
  console.error("working tree is not clean; commit or stash first:\n" + dirty);
  process.exit(1);
}

run(`node scripts/set-version.mjs ${version}`);
run("npm install"); // sync node_modules + confirm the lockfile is installable
run("npx biome check packages/");
run("npm test");

run("git add -A");
run(`git commit -q -m "chore: release ${version}"`);
run(`git tag "v${version}"`);

console.log(`\nreleased v${version} locally. Now push to trigger publish:\n  git push origin main --follow-tags`);
