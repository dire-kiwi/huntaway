#!/usr/bin/env node
// The desktop packages (docs/plan/inventory/11-mobile-tooling.md §2.10): electron-builder over the built shell (dist/)
// and a packaged server, with the old app's targets: AppImage and pacman on Linux, dmg and zip on a Mac.
//
//   pnpm --filter huntaway-desktop run dist [--server <dir>] [--linux | --mac] [--x64 | --arm64]
//
// --server <dir>  the packaged server (scripts/package-server.sh <dir>: huntaway, ia-shim, node/, server/, ui/), copied
//                 into the app's resources; default $HUNTAWAY_RELEASE_SERVER, else release-server/ at the top of the
//                 checkout
// $VERSION        the version the app reports (the release's), written into the packaged package.json
//
// The packages land in apps/desktop/release/. Nothing is published.
//
// Until the switch (docs/plan/11-migration.md) the app installs beside the old one (dire-kiwi/huntaway-legacy), so every name
// the system sees is its own: the Arch package huntaway-effect in /opt/Huntaway Effect, /usr/bin/huntaway-effect-desktop,
// huntaway-effect-desktop.desktop (Electron's WM_CLASS) and its icon, "Huntaway Effect.app" and its bundle id on a Mac.
// The old package is huntaway in /opt/Huntaway with huntaway-desktop. The release files keep the old names
// (huntaway-<v>-<os>-<arch>.<ext>): they are on this repository's releases, and the updaters look for them by name.
import { existsSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "electron-builder"
import type { Configuration } from "electron-builder"

const here = fileURLToPath(new URL("..", import.meta.url))
const args = process.argv.slice(2)
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const server = resolve(option("--server") ?? process.env["HUNTAWAY_RELEASE_SERVER"] ?? resolve(here, "../../release-server"))

const missing = ["huntaway", "ia-shim", "ui/index.html"].filter((file) => !existsSync(resolve(server, file)) || !statSync(resolve(server, file)).isFile())
if (missing.length > 0) {
  console.error(`dist: ${server} is not a packaged server (no ${missing.join(", ")}); make one with scripts/package-server.sh ${server}`)
  process.exit(2)
}
for (const file of ["boot.cjs", "main.cjs", "preload.cjs"]) {
  if (!existsSync(resolve(here, "dist", file))) {
    console.error(`dist: dist/${file} is missing; build the shell first (vp pack)`)
    process.exit(2)
  }
}

const version = process.env["VERSION"]?.trim()
const config: Configuration = {
  appId: "nz.net.ivan.huntaway-effect",
  productName: "Huntaway Effect",
  // The shell is bundled with its dependencies (vite.config.ts): the app carries no node_modules.
  files: ["dist/**", "package.json", "!node_modules/**"],
  extraResources: [{ from: server, to: ".", filter: ["**/*"] }],
  artifactName: "huntaway-${version}-${os}-${arch}.${ext}",
  // desktopName is Electron's app_id / WM_CLASS on Linux: the .desktop file is named after it, so that desktops match the
  // app's windows to it. $VERSION, when given, is the version the app reports.
  extraMetadata: { desktopName: "huntaway-effect-desktop.desktop", ...(version === undefined || version === "" ? {} : { version }) },
  linux: {
    target: ["AppImage", "pacman"],
    executableName: "huntaway-effect-desktop",
    syncDesktopName: true,
    category: "Development",
    icon: "build/icon.png",
    synopsis: "Kanban board for Claude Code and Codex agents",
    description: "A kanban board for orchestrating Claude Code and Codex agents.",
    maintainer: "Huntaway <https://github.com/dire-kiwi/huntaway>",
  },
  pacman: {
    packageName: "huntaway-effect",
    depends: ["gtk3", "nss", "alsa-lib", "libxss", "libxtst", "libnotify", "libsecret", "at-spi2-core", "xdg-utils", "git"],
    fpm: ["--description", "Kanban board for Claude Code and Codex agents"],
  },
  mac: {
    target: ["dmg", "zip"],
    category: "public.app-category.developer-tools",
    icon: "build/icon.png",
    // Signed ad hoc, not notarised: users clear the quarantine themselves.
    identity: "-",
    hardenedRuntime: false,
  },
  directories: { output: "release" },
}

const arch = args.includes("--arm64") ? { arm64: true } : args.includes("--x64") ? { x64: true } : {}
const platform = args.includes("--mac") ? { mac: [] } : args.includes("--linux") ? { linux: [] } : {}
await build({ projectDir: here, config, publish: "never", ...platform, ...arch })
