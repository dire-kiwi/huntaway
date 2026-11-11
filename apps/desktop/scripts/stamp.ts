#!/usr/bin/env node
// What a release records about the desktop shell it was built with (docs/plan/inventory/11-mobile-tooling.md §2.9), from
// the built dist/ and the Electron installed here:
//
//   node scripts/stamp.ts               {"shell": <frame stamp>, "electron": <version>}, for huntaway-<v>-release.json
//   node scripts/stamp.ts --shell-json  {"electron": <version>, "boot": <boot API>}, the release tarball's electron/shell.json
//
// The frame stamp is the main process's (src/main/stamp.ts): sha256 over "boot.cjs", dist/boot.cjs's contents, then
// the Electron version. Run `pnpm --filter huntaway-desktop build` first.
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { BOOT_API } from "../src/shared/versions.ts"

const dist = fileURLToPath(new URL("../dist/", import.meta.url))
const installed: unknown = createRequire(import.meta.url)("electron/package.json")
const electron = typeof installed === "object" && installed !== null && "version" in installed ? String(installed.version) : ""

if (process.argv.includes("--shell-json")) {
  console.log(JSON.stringify({ electron, boot: BOOT_API }))
} else {
  const shell = createHash("sha256")
    .update("boot.cjs")
    .update(readFileSync(`${dist}boot.cjs`))
    .update(electron)
    .digest("hex")
  console.log(JSON.stringify({ shell, electron }))
}
