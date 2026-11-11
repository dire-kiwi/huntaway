import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vite-plus/test"
import { dataDirFor } from "../shared/paths.ts"
import { BOOT_API } from "../shared/versions.ts"
import { findShell, markShellBad, readJson, readShellState, settleCrash, writeShellState } from "./shells.ts"

// The old shell's desktop-boot.test.ts: which release's shell the frame loads, and a shell that crashed.

const dirs: Array<string> = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const ELECTRON = "45.3.0"

const touch = (file: string, contents = "") => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, contents)
}

/** A data folder's app/ with `state` in state.json, each of `versions` installed with its server files and, unless `shell` is false, a shell. */
const appDir = (
  state: object | null,
  versions: ReadonlyArray<string> = [],
  { shell = true, meta = { electron: ELECTRON, boot: 1 } }: { shell?: boolean; meta?: object } = {},
) => {
  const dir = mkdtempSync(join(tmpdir(), "desktop-boot-"))
  dirs.push(dir)
  for (const v of versions) {
    for (const file of ["huntaway", "ia-shim", "ui/index.html", ...(shell ? ["electron/main.cjs"] : [])]) touch(join(dir, v, file))
    if (shell) touch(join(dir, v, "electron", "shell.json"), JSON.stringify(meta))
  }
  if (state !== null) touch(join(dir, "state.json"), JSON.stringify(state))
  return dir
}

const choose = (dir: string, appVersion = "0.1.0", electronVersion = ELECTRON) => findShell({ appDir: dir, appVersion, electronVersion, platform: "linux" })
const shellOf = (dir: string, version: string) => ({ dir: join(dir, version, "electron"), version })

describe("which shell the frame loads", () => {
  it("the shell of the version the server runs is loaded", () => {
    const dir = appDir({ current: "0.2.0", previous: "0.1.1" }, ["0.2.0", "0.1.1"])
    expect(choose(dir)).toEqual(shellOf(dir, "0.2.0"))
    // An Update that is still coming up (trying) is the server about to run.
    expect(choose(appDir({ trying: "0.3.0", current: "0.2.0" }, ["0.3.0", "0.2.0"]))?.version).toBe("0.3.0")
  })

  it("the package's own shell is used without a downloaded version, or when the package is newer", () => {
    expect(choose(join(tmpdir(), "desktop-boot-none"))).toBe(null)
    expect(choose(appDir(null, ["0.2.0"]))).toBe(null)
    expect(choose(appDir({ staged: "0.2.0" }, ["0.2.0"]))).toBe(null)
    expect(choose(appDir({ current: "0.2.0" }, ["0.2.0"]), "0.3.0")).toBe(null)
  })

  it("a bad or incomplete version is passed over, and a shell-less one isn't skipped for an older one", () => {
    expect(choose(appDir({ current: "0.3.0", previous: "0.2.0", bad: ["0.3.0"] }, ["0.3.0", "0.2.0"]))?.version).toBe("0.2.0")
    // A version missing its server files isn't the server's, whatever shell it has.
    const incomplete = appDir({ current: "0.3.0", previous: "0.2.0" }, ["0.2.0"])
    touch(join(incomplete, "0.3.0", "electron", "main.cjs"))
    expect(choose(incomplete)?.version).toBe("0.2.0")
    // A release from before shells were shipped: the package's shell, not the previous version's.
    const old = appDir({ current: "0.3.0", previous: "0.2.0" }, ["0.2.0"])
    for (const file of ["huntaway", "ia-shim", "ui/index.html"]) touch(join(old, "0.3.0", file))
    expect(choose(old)).toBe(null)
  })

  it("a shell for another Electron, or needing a newer frame, isn't loaded", () => {
    expect(choose(appDir({ current: "0.2.0" }, ["0.2.0"], { meta: { electron: "46.0.0", boot: 1 } }))).toBe(null)
    expect(choose(appDir({ current: "0.2.0" }, ["0.2.0"], { meta: { electron: "45.9.9", boot: 1 } }))?.version).toBe("0.2.0")
    expect(choose(appDir({ current: "0.2.0" }, ["0.2.0"], { meta: { electron: ELECTRON, boot: BOOT_API + 1 } }))).toBe(null)
    expect(choose(appDir({ current: "0.2.0" }, ["0.2.0"], { meta: { electron: ELECTRON } }))).toBe(null)
    const noMeta = appDir({ current: "0.2.0" }, ["0.2.0"])
    rmSync(join(noMeta, "0.2.0", "electron", "shell.json"))
    expect(choose(noMeta)).toBe(null)
  })

  it("a shell marked bad isn't loaded again, and state.json's own bad list is left alone", () => {
    const dir = appDir({ current: "0.3.0", previous: "0.2.0" }, ["0.3.0", "0.2.0"])
    markShellBad(dir, "0.3.0")
    expect(choose(dir)).toBe(null)
    expect(readShellState(dir)["bad"]).toEqual(["0.3.0"])
    // The server isn't blamed for its shell.
    expect(readJson(join(dir, "state.json"))["bad"]).toBe(undefined)
    markShellBad(dir, "0.3.0")
    expect(readShellState(dir)["bad"]).toEqual(["0.3.0"])
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([])
  })

  it("a shell whose process died while it ran is marked bad, unless that process is still running", () => {
    const lines: Array<string> = []
    const dir = appDir({ current: "0.2.0" }, ["0.2.0"])
    writeShellState(dir, { trying: { version: "0.2.0", pid: 2 ** 22 + 12_345 } })
    expect(settleCrash(dir, (line) => lines.push(line))).toBe(false)
    expect(readShellState(dir)["bad"]).toEqual(["0.2.0"])
    expect(readShellState(dir)["trying"]).toBe(undefined)
    expect(lines).toHaveLength(1)

    // Another app process (the test runner's parent is as good as any) still has its shell loaded.
    const other = appDir({ current: "0.2.0" }, ["0.2.0"])
    writeShellState(other, { trying: { version: "0.2.0", pid: process.ppid } })
    expect(settleCrash(other, (line) => lines.push(line))).toBe(true)
    expect(readShellState(other)["bad"]).toBe(undefined)
    expect(choose(other)?.version).toBe("0.2.0")

    expect(settleCrash(appDir(null), (line) => lines.push(line))).toBe(false)
    expect(JSON.parse(readFileSync(join(dir, "shell-state.json"), "utf8"))).toEqual({ bad: ["0.2.0"] })
  })
})

const at = (configDataDir: string | null, envDataDir: string | null = null, xdgDataHome: string | null = null) =>
  dataDirFor({ envDataDir, configDataDir, home: "/home/u", xdgDataHome })

describe("the data folder", () => {
  it("is found as the server finds it", () => {
    expect(at(null, "/x")).toBe("/x")
    expect(at("~/d")).toBe("/home/u/d")
    expect(at(null)).toBe("/home/u/.local/share/huntaway-effect")
    expect(at(null, null, "/xdg")).toBe("/xdg/huntaway-effect")
  })
})
