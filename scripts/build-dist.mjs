#!/usr/bin/env node
// Build the flat, pi-installable extension from the monorepo. pi loads an
// extension with `index.ts` at the repo root and can't consume the monorepo
// layout, so we produce `packages/extension`'s files at the root with
// `packages/components` vendored into `vendor/pi-webui-components` and the
// workspace dependency rewritten to a `file:` path (no registry needed).
//
// Usage: node scripts/build-dist.mjs <x.y.z> [outDir=dist]

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const version = process.argv[2];
const out = process.argv[3] || "dist";
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version || "")) {
  console.error("usage: node scripts/build-dist.mjs <x.y.z> [outDir]");
  process.exit(1);
}

const INTERNAL = "@wirelessr/pi-webui-components";
// Never copy installed deps, generated locks, or per-session runtime data.
const skip = new Set(["node_modules", "data", "package-lock.json"]);
const filter = (base) => (src) => !skip.has(src.slice(base.length + 1).split("/")[0]);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 1. Extension files at the root.
cpSync("packages/extension", out, { recursive: true, filter: filter("packages/extension") });

// 2. Vendor the components package.
const vendor = join(out, "vendor", "pi-webui-components");
cpSync("packages/components", vendor, { recursive: true, filter: filter("packages/components") });

// 2b. Carry the shared biome config so the extension's own lint script resolves.
cpSync("biome.json", join(out, "biome.json"));

// 3. Root package.json: stamp version, point the internal dep at the vendor copy.
const pkgPath = join(out, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.version = version;
for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
  if (pkg[field]?.[INTERNAL]) pkg[field][INTERNAL] = "file:./vendor/pi-webui-components";
}
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

// 4. Stamp the vendored package version to match.
const vpkgPath = join(vendor, "package.json");
const vpkg = JSON.parse(readFileSync(vpkgPath, "utf8"));
vpkg.version = version;
writeFileSync(vpkgPath, `${JSON.stringify(vpkg, null, 2)}\n`);

console.log(`build-dist: ${out}/ ready (pi-webui-extension@${version}, components vendored)`);
