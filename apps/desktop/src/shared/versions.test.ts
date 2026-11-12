import { describe, expect, it } from "vite-plus/test"
import {
  assetPlatform,
  chooseServer,
  chooseShell,
  compareVersions,
  installKind,
  markBad,
  packageName,
  releaseEnv,
  serverFiles,
  shellChange,
  shellSuits,
  updateKind,
} from "./versions.ts"
import type { AppState } from "./versions.ts"

// The old shell's tests of versions.cjs, stamp.cjs and shellupdate.cjs's pure parts (apps/web/tests/desktop-*.test.ts),
// on the decisions alone: which versions are installed is given rather than laid out in a folder (src/boot/shells.test.ts
// and src/main/Servers.test.ts do that).

/** chooseServer over `state`, with `installed` the complete versions. */
const choose = (state: AppState, installed: ReadonlyArray<string>, minVersion = "0.1.0", skip: ReadonlyArray<string> = []) =>
  chooseServer({ state, minVersion, skip, installed: (v) => installed.includes(v) })

describe("which server a release build starts", () => {
  it("the current version runs rather than the bundled one, unless the package is newer", () => {
    const state = { current: "0.2.0", previous: "0.1.1", bad: [] }
    expect(choose(state, ["0.2.0", "0.1.1"])).toBe("0.2.0")
    // The same version as the package's is still the downloaded one.
    expect(choose(state, ["0.2.0", "0.1.1"], "0.2.0")).toBe("0.2.0")
    // A pacman upgrade to 0.3.0 wins over both downloads.
    expect(choose(state, ["0.2.0", "0.1.1"], "0.3.0")).toBe(null)
    // Between the two, the previous one is too old as well.
    expect(choose(state, ["0.2.0", "0.1.1"], "0.2.1")).toBe(null)
  })

  it("without a state.json, the bundled server runs", () => {
    expect(choose({}, ["0.2.0"])).toBe(null)
  })

  it("bad versions are passed over, and a staged one is never started", () => {
    const state = { current: "0.3.0", previous: "0.2.0", staged: "0.4.0", bad: ["0.3.0"] }
    expect(choose(state, ["0.4.0", "0.3.0", "0.2.0"])).toBe("0.2.0")
    // One that failed just now, before state.json says so.
    expect(choose(state, ["0.4.0", "0.3.0", "0.2.0"], "0.1.0", ["0.2.0"])).toBe(null)
    // Only staged: the bundled one runs until Update.
    expect(choose({ staged: "0.4.0" }, ["0.4.0"])).toBe(null)
  })

  it("trying comes first, and once it's marked bad (nothing came up) the current one runs", () => {
    const state = { current: "0.2.0", previous: "0.1.1", trying: "0.3.0", bad: ["0.0.9"], extra: { kept: true } }
    expect(choose(state, ["0.3.0", "0.2.0", "0.1.1"])).toBe("0.3.0")
    const marked = markBad(state, "0.3.0")
    expect(choose(marked, ["0.3.0", "0.2.0", "0.1.1"])).toBe("0.2.0")
    // The keys the shell doesn't know are kept, and nothing is added twice.
    expect(markBad(marked, "0.3.0")).toEqual({ current: "0.2.0", previous: "0.1.1", trying: null, bad: ["0.0.9", "0.3.0"], extra: { kept: true } })
    // Marking another version bad leaves trying alone.
    expect(markBad({ current: "0.2.0", trying: "0.3.0" }, "0.2.0")).toEqual({ current: "0.2.0", trying: "0.3.0", bad: ["0.2.0"] })
    // A state.json without `bad`.
    expect(choose(markBad({ current: "0.2.0" }, "0.2.0"), ["0.2.0"])).toBe(null)
  })

  it("a version missing any of its files is passed over", () => {
    expect(serverFiles("huntaway")).toEqual(["huntaway", "ia-shim", "ui/index.html"])
    expect(serverFiles("huntaway.exe")).toEqual(["huntaway.exe", "ia-shim.exe", "ui/index.html"])
    expect(choose({ current: "0.3.0", previous: "0.2.0" }, ["0.2.0"])).toBe("0.2.0")
  })

  it("versions that aren't semver are never started", () => {
    expect(choose({ current: "../0.2.0", previous: "latest", trying: 3 }, ["../0.2.0", "latest"])).toBe(null)
  })

  it("versions compare as semver, prereleases below their release", () => {
    const ordered = [
      "0.9.0",
      "0.10.0-alpha",
      "0.10.0-alpha.1",
      "0.10.0-alpha.beta",
      "0.10.0-beta",
      "0.10.0-beta.2",
      "0.10.0-beta.11",
      "0.10.0-rc.1",
      "0.10.0",
      "0.10.1",
      "1.0.0",
    ]
    for (const [i, a] of ordered.entries()) {
      for (const [j, b] of ordered.entries()) expect(Math.sign(compareVersions(a, b)), `${a} vs ${b}`).toBe(Math.sign(i - j))
    }
    expect(compareVersions("v1.2.3", "1.2.3+build.5")).toBe(0)
    expect(compareVersions("1.2", "1.2.0")).toBeNaN()
    // An rc of the package's own version is older than the package.
    expect(choose({ current: "0.2.0-rc.1" }, ["0.2.0-rc.1"], "0.2.0")).toBe(null)
    expect(choose({ current: "0.2.0-rc.1" }, ["0.2.0-rc.1"], "0.2.0-beta.3")).toBe("0.2.0-rc.1")
  })
})

const shell = (state: AppState, options: { shellBad?: ReadonlyArray<string>; usable?: ReadonlyArray<string>; appVersion?: string } = {}) =>
  chooseShell({
    state,
    shellBad: options.shellBad ?? [],
    appVersion: options.appVersion ?? "0.1.0",
    installed: (v) => ["0.3.0", "0.2.0"].includes(v),
    usable: (v) => (options.usable ?? ["0.3.0", "0.2.0"]).includes(v),
  })

describe("which shell the frame loads", () => {
  it("the shell of the version the server runs, never an older version's", () => {
    expect(shell({ current: "0.2.0" })).toBe("0.2.0")
    expect(shell({ trying: "0.3.0", current: "0.2.0" })).toBe("0.3.0")
    expect(shell({ current: "0.3.0", previous: "0.2.0", bad: ["0.3.0"] })).toBe("0.2.0")
    // A release from before shells were shipped: the package's shell, not the previous version's.
    expect(shell({ current: "0.3.0", previous: "0.2.0" }, { usable: ["0.2.0"] })).toBe(null)
    // A shell that failed doesn't move the choice to an older version's either.
    expect(shell({ current: "0.3.0", previous: "0.2.0" }, { shellBad: ["0.3.0"] })).toBe(null)
    // A newer package takes over from older downloads, as it does for the server.
    expect(shell({ current: "0.2.0" }, { appVersion: "0.3.0" })).toBe(null)
  })

  it("a shell for another Electron, or needing a newer frame, doesn't suit", () => {
    expect(shellSuits({ electron: "45.0.0", boot: 1 }, "45.3.0")).toBe(true)
    expect(shellSuits({ electron: "45.9.9", boot: 1 }, "45.3.0")).toBe(true)
    expect(shellSuits({ electron: "46.0.0", boot: 1 }, "45.3.0")).toBe(false)
    expect(shellSuits({ electron: "45.3.0", boot: 2 }, "45.3.0")).toBe(false)
    expect(shellSuits({ electron: "45.3.0" }, "45.3.0")).toBe(false)
    expect(shellSuits(null, "45.3.0")).toBe(false)
  })
})

describe("when the app relaunches", () => {
  it("a Roll back or an Update that changes which shell the frame would load relaunches, whatever the stamp", () => {
    expect(shellChange({ boot: { running: "0.3.0", chosen: "0.3.0" }, stampNow: null, startStamp: "a" })).toBe(null)
    expect(shellChange({ boot: { running: "0.3.0", chosen: "0.2.0" }, stampNow: null, startStamp: "a" })).toMatch(/different desktop shell/)
    // Back to the package's shell.
    expect(shellChange({ boot: { running: "0.3.0", chosen: null }, stampNow: null, startStamp: "a" })).toMatch(/different desktop shell/)
  })

  it("a shell loaded from a release isn't hashed, and a checkout still relaunches on a change", () => {
    expect(shellChange({ boot: { running: "0.2.0", chosen: "0.2.0" }, stampNow: "b", startStamp: "a" })).toBe(null)
    expect(shellChange({ boot: null, stampNow: "b", startStamp: "a" })).toBe("the desktop app changed on disk")
    expect(shellChange({ boot: null, stampNow: "a", startStamp: "a" })).toBe(null)
    // Unreadable files aren't a change.
    expect(shellChange({ boot: null, stampNow: null, startStamp: "a" })).toBe(null)
    // The package's own shell in a release build: the stamp still applies.
    expect(shellChange({ boot: { running: null, chosen: null }, stampNow: "b", startStamp: "a" })).toBe("the desktop app changed on disk")
  })
})

const never = () => expect.unreachable("pacman isn't asked")

describe("how the app was installed, and what it can install of itself", () => {
  it("the install kind and the environment for a release build's server", () => {
    expect(installKind({ platform: "linux", appimage: "/home/u/Huntaway.AppImage", resourcesPath: "/tmp/.mount_x/resources", pacmanOwns: never })).toBe(
      "appimage:/home/u/Huntaway.AppImage",
    )
    expect(installKind({ platform: "linux", appimage: null, resourcesPath: "/opt/Huntaway/resources", pacmanOwns: () => true })).toBe("pacman")
    expect(installKind({ platform: "linux", appimage: null, resourcesPath: "/opt/Huntaway/resources", pacmanOwns: () => false })).toBe("other")
    expect(installKind({ platform: "linux", appimage: null, resourcesPath: "/home/u/huntaway/resources", pacmanOwns: never })).toBe("other")
    expect(installKind({ platform: "darwin", appimage: null, resourcesPath: "/Applications/Huntaway.app/Contents/Resources", pacmanOwns: never })).toBe(
      "mac:/Applications/Huntaway.app",
    )

    const desktop = { version: "0.2.0", shell: "abc", install: "pacman", bundled: "/opt/Huntaway/resources/huntaway" }
    expect(releaseEnv({ releaseUpdates: null, ...desktop })).toEqual({
      HUNTAWAY_RELEASE_UPDATES: "dire-kiwi/huntaway-effect",
      HUNTAWAY_DESKTOP_VERSION: "0.2.0",
      HUNTAWAY_DESKTOP_SHELL: "abc",
      HUNTAWAY_DESKTOP_INSTALL: "pacman",
      HUNTAWAY_BUNDLED_SERVER: "/opt/Huntaway/resources/huntaway",
    })
    expect(releaseEnv({ releaseUpdates: "me/fork", ...desktop }).HUNTAWAY_RELEASE_UPDATES).toBe("me/fork")
    // Blank turns them off (the server takes a blank HUNTAWAY_RELEASE_UPDATES as none).
    expect(releaseEnv({ releaseUpdates: "", ...desktop }).HUNTAWAY_RELEASE_UPDATES).toBe("")
  })

  it("which installs the app updates itself, and the packages' names", () => {
    expect(updateKind("appimage:/home/me/Huntaway.AppImage")).toBe("appimage")
    expect(updateKind("pacman")).toBe("pacman")
    for (const other of ["mac:/Applications/Huntaway.app", "other", null]) expect(updateKind(other)).toBe(null)
    expect(assetPlatform("linux", "x64")).toBe("linux-x64")
    expect(assetPlatform("darwin", "arm64")).toBe("mac-arm64")
    // As electron-builder names them (see the v0.1.0 release).
    expect(packageName("appimage", "0.1.0", "linux-x64")).toBe("huntaway-0.1.0-linux-x86_64.AppImage")
    expect(packageName("appimage", "0.1.0", "linux-arm64")).toBe("huntaway-0.1.0-linux-arm64.AppImage")
    expect(packageName("pacman", "0.1.0", "linux-x64")).toBe("huntaway-0.1.0-linux-x64.pacman")
  })
})
