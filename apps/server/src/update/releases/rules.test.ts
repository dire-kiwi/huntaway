import { assert, describe, it } from "@effect/vitest"
import { pickCommit } from "../../platform/ServerConfig.ts"
import { offered, packageName, pick, rateLimit, shellStatus, statusText } from "./github.ts"
import type { GhRelease, Latest } from "./github.ts"
import { chooseAtStartup, emptyInstalled, fromRecord, notRolledBack, rolledBack, settled, superseded, toPrune, toRecord } from "./installed.ts"
import type { Installed } from "./installed.ts"
import { compare, parseVersion, versionString } from "./semver.ts"
import type { Semver } from "./semver.ts"
import { checkEntries, checkTypes, printsVersion } from "./tarball.ts"

// The release rules as plain functions: the cases of the old update/release/tests.test.ts and admin.test.ts that
// don't need a server (the rest are in Releases.test.ts, on a fake GitHub).

const v = (s: string): Semver => parseVersion(s) ?? assert.fail(`${s} isn't a version`)

const DIGEST = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

const asset = (name: string, digest: string | null) => ({ name, browser_download_url: `http://x/download/${name}`, size: 42, digest })

/** A release of `tag` with a server tarball for linux-x64 and mac-arm64, a pacman package, an AppImage and a manifest. */
const release = (tag: string, prerelease = false) => {
  const version = tag.replace(/^v+/, "")
  return {
    tag_name: tag,
    draft: false,
    prerelease,
    published_at: "2026-10-01T00:00:00Z",
    body: `notes for ${version}`,
    html_url: `https://github.com/o/r/releases/tag/${tag}`,
    assets: [
      asset(`huntaway-server-${version}-linux-x64.tar.gz`, DIGEST),
      asset(`huntaway-server-${version}-mac-arm64.tar.gz`, DIGEST),
      asset(`huntaway-${version}-linux-x64.pacman`, DIGEST),
      asset(`huntaway-${version}-linux-x86_64.AppImage`, DIGEST),
      asset(`huntaway-${version}-release.json`, DIGEST),
    ],
  }
}

const picked = (releases: ReadonlyArray<GhRelease>, pre = false, bad: ReadonlyArray<string> = []) => {
  const p = pick(releases, "linux-x64", pre, bad)
  return p === null ? null : versionString(p.version)
}

const state = (s: Partial<Installed>): Installed => ({ ...emptyInstalled, ...s })

describe("versions", () => {
  it("orders as semver does", () => {
    const ordered = ["0.1.0", "0.2.0-alpha", "0.2.0-alpha.1", "0.2.0-alpha.beta", "0.2.0-beta.2", "0.2.0-beta.11", "0.2.0-rc.1", "0.2.0", "0.10.0", "1.0.0"]
    for (let i = 1; i < ordered.length; i++) assert.isBelow(compare(v(ordered[i - 1] ?? ""), v(ordered[i] ?? "")), 0, `${ordered[i - 1]} < ${ordered[i]}`)
    for (const bad of ["1.2", "01.2.3", "v1.2.3", "1.2.3-", "release/v1"]) assert.isNull(parseVersion(bad), bad)
    assert.strictEqual(versionString(v("1.2.3-rc.1+b5")), "1.2.3-rc.1+b5")
  })
})

describe("picking a release", () => {
  it("picks_the_highest_version_with_a_server_for_this_platform", () => {
    assert.strictEqual(picked([release("v0.1.0"), release("0.10.0"), release("v0.2.0")]), "0.10.0")
  })

  it("skips_drafts_tags_that_arent_semver_and_assets_without_a_digest", () => {
    const draft = { ...release("v0.4.0"), draft: true }
    const undigested = { ...release("v0.3.0"), assets: [asset("huntaway-server-0.3.0-linux-x64.tar.gz", null)] }
    const badDigest = { ...release("v0.2.5"), assets: [asset("huntaway-server-0.2.5-linux-x64.tar.gz", "md5:abc")] }
    const otherPlatform = { tag_name: "v0.2.2", assets: [asset("huntaway-server-0.2.2-mac-arm64.tar.gz", DIGEST)] }
    const stray = { tag_name: "release/v1", assets: [] }
    assert.strictEqual(picked([draft, undigested, badDigest, otherPlatform, stray, release("v0.2.0")]), "0.2.0")
    assert.isNull(picked([stray]))
  })

  it("prereleases_count_only_when_the_setting_is_on", () => {
    const list = [release("v0.3.0-beta.1", true), release("v0.2.0")]
    assert.strictEqual(picked(list), "0.2.0")
    assert.strictEqual(picked(list, true), "0.3.0-beta.1")
  })

  it("a_bad_version_isnt_offered", () => {
    const list = [release("v0.3.0"), release("v0.2.0")]
    assert.strictEqual(picked(list, false, ["0.3.0"]), "0.2.0")
    assert.deepStrictEqual(
      offered(list, "linux-x64", false, ["0.3.0"]).map((o) => versionString(o.version)),
      ["0.2.0"],
    )
  })

  it("says when GitHub's rate limit resets, and only for the rate limit", () => {
    assert.deepStrictEqual(rateLimit(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1793491200" }), { reset: "2026-11-01T00:00:00Z" })
    assert.deepStrictEqual(rateLimit(429, { "x-ratelimit-remaining": "0" }), { reset: null })
    assert.isNull(rateLimit(403, { "x-ratelimit-remaining": "12" }))
    assert.isNull(rateLimit(500, { "x-ratelimit-remaining": "0" }))
    assert.strictEqual(statusText(500), "500 Internal Server Error")
  })
})

const desktop = { version: "0.1.0", shell: "shell-0.2.0", install: "pacman", platform: "linux-x64" }

const latest = (tag: string, shell: string | null): Latest => {
  const r = release(tag)
  return { version: v(tag.replace(/^v/, "")), release: r, asset: r.assets[0] ?? asset("x", DIGEST), manifest: shell === null ? null : { shell } }
}

describe("the desktop shell", () => {
  it("the_manifest_says_whether_the_shell_is_outdated", () => {
    assert.strictEqual(shellStatus(desktop, latest("v0.2.0", "shell-0.2.0"))?.outdated, false)
    const newer = shellStatus(desktop, latest("v0.3.0", "shell-0.3.0"))
    assert.deepStrictEqual(
      [newer?.outdated, newer?.package?.name, newer?.install, newer?.version],
      [true, "huntaway-0.3.0-linux-x64.pacman", "pacman", "0.1.0"],
    )
    // Without a manifest, it can't say.
    assert.strictEqual(shellStatus(desktop, latest("v0.4.0", null))?.outdated, false)
  })

  it("an_app_newer_than_the_latest_release_isnt_offered_its_package", () => {
    const l = latest("v0.2.0", "shell-0.2.0")
    for (const [app, outdated] of [
      ["0.3.0-rc.1", false],
      ["0.2.0", false],
      ["0.2.0-rc.1", true],
      ["0.1.0", true],
      ["not a version", false],
    ] as const) {
      assert.strictEqual(shellStatus({ ...desktop, version: app, shell: "shell-0.3.0-rc.1" }, l)?.outdated, outdated, app)
    }
    // Without the app's version, the stamps decide.
    assert.strictEqual(shellStatus({ ...desktop, version: null, shell: "shell-0.3.0-rc.1" }, l)?.outdated, true)
  })

  it("shell_reports_how_the_app_was_installed", () => {
    const l = latest("v0.2.0", "shell-0.2.0")
    const s = shellStatus({ ...desktop, install: "appimage:/home/me/Huntaway.AppImage" }, l)
    assert.deepStrictEqual([s?.install, s?.path, s?.package?.name], ["appimage", "/home/me/Huntaway.AppImage", "huntaway-0.2.0-linux-x86_64.AppImage"])
    assert.strictEqual(packageName("appimage", "0.2.0", "linux-arm64"), "huntaway-0.2.0-linux-arm64.AppImage")
    assert.strictEqual(packageName("pacman", "0.2.0", "linux-x64"), "huntaway-0.2.0-linux-x64.pacman")
    const mac = shellStatus({ ...desktop, install: "mac:/Applications/Huntaway.app" }, l)
    assert.deepStrictEqual([mac?.install, mac?.package], ["mac", null])
    // A server no app started has no shell.
    assert.isNull(shellStatus({ version: null, shell: null, install: null, platform: "linux-x64" }, l))
  })
})

describe("the tarball", () => {
  it("entries_outside_the_folder_and_links_are_refused", () => {
    assert.isNull(checkEntries("top/\ntop/huntaway\ntop/ui/index.html\n"))
    assert.include(checkEntries("top/huntaway\ntop/../evil\n") ?? "", "outside its folder")
    assert.include(checkEntries("/etc/passwd\n") ?? "", "outside its folder")
    assert.include(checkEntries("./x\n") ?? "", "outside its folder")
    assert.include(checkEntries("a/x\nb/y\n") ?? "", "more than one top folder (a and b)")
    assert.strictEqual(checkEntries(""), "it's empty")
    assert.isNull(checkTypes("drwxr-xr-x u/g 0 2026-01-01 00:00 top/\n-rwxr-xr-x u/g 5 2026-01-01 00:00 top/huntaway\n"))
    assert.include(checkTypes("lrwxrwxrwx u/g 0 2026-01-01 00:00 top/etc -> /etc\n") ?? "", "isn't a file or a folder")
  })

  it("the smoke test wants the version it was given", () => {
    assert.isTrue(printsVersion("huntaway 0.2.0\n", "0.2.0"))
    assert.isTrue(printsVersion("huntaway v0.2.0\n", "0.2.0"))
    assert.isFalse(printsVersion("huntaway 0.1.9\n", "0.2.0"))
  })
})

describe("app/state.json", () => {
  it("state_json_round_trips_with_unknown_keys", () => {
    const s = fromRecord({ current: "0.2.0", previous: null, staged: "0.3.0", trying: 7, bad: ["0.2.5", 3], launches: [1, 2], x: "y" })
    assert.deepStrictEqual([s.current, s.staged, s.trying, s.bad], ["0.2.0", "0.3.0", null, ["0.2.5"]])
    assert.deepStrictEqual(toRecord({ ...s, trying: "0.3.0" }), {
      current: "0.2.0",
      previous: null,
      staged: "0.3.0",
      trying: "0.3.0",
      bad: ["0.2.5"],
      launches: [1, 2],
      x: "y",
    })
    assert.deepStrictEqual(Object.keys(toRecord(fromRecord({ z: 1, a: 2, bad: [] }))), ["current", "previous", "staged", "trying", "bad", "a", "z"])
  })

  it("settling_keeps_current_previous_and_staged", () => {
    // An Update from 0.1.0 onto 0.2.0.
    const before = state({ current: "0.1.0", previous: "0.1.5", staged: "0.2.0", trying: "0.2.0", bad: ["0.0.9"] })
    const after = settled(before, "0.2.0")
    assert.deepStrictEqual(toRecord(after), { current: "0.2.0", previous: "0.1.0", staged: null, trying: null, bad: ["0.0.9"] })
    const entries = ["0.1.0", "0.1.5", "0.2.0", "0.3.0", "0.4.0.partial"].map((name) => ({ name, dir: true }))
    const files = ["state.json", "state.json.123.tmp", "notes.txt"].map((name) => ({ name, dir: false }))
    assert.deepStrictEqual(toPrune([...entries, ...files], after), ["0.1.5", "0.3.0", "0.4.0.partial", "state.json.123.tmp"])
    // A later start keeps previous, and a newer staged version; one not newer (updated past it) is dropped.
    assert.deepStrictEqual(toRecord(settled({ ...after, staged: "0.3.0" }, "0.2.0")).staged, "0.3.0")
    assert.deepStrictEqual(toRecord(settled({ ...after, staged: "0.1.5" }, "0.2.0")).staged, null)
    // A bad staged version isn't offered and is pruned.
    const bad = settled(state({ current: "0.2.0", previous: "0.1.5", staged: "0.3.0", bad: ["0.3.0"] }), "0.2.0")
    assert.deepStrictEqual([bad.staged, bad.bad], [null, ["0.3.0"]])
  })

  it("a_server_started_again_picks_the_version_it_updated_to", () => {
    const has = new Set(["0.2.0", "0.3.0"])
    const choose = (s: Installed, running: string) => chooseAtStartup(s, v(running), (x) => has.has(x))
    // Nothing downloaded: nothing to pick.
    assert.isNull(choose(emptyInstalled, "0.1.0").pick)
    let r = choose(state({ current: "0.3.0", previous: "0.2.0" }), "0.1.0")
    assert.deepStrictEqual([r.pick, r.next.trying, r.failed], ["0.3.0", "0.3.0", null])
    // A newer tarball (0.3.0 or later) runs itself.
    assert.isNull(choose(state({ current: "0.3.0", previous: "0.2.0" }), "0.3.0").pick)
    assert.isNull(choose(state({ current: "0.3.0", previous: "0.2.0" }), "0.4.0").pick)
    // 0.3.0 exited before it was listening: it's bad, and 0.2.0 is current and tried.
    r = choose(state({ current: "0.3.0", previous: "0.2.0", trying: "0.3.0" }), "0.1.0")
    assert.deepStrictEqual(
      [r.pick, r.failed, r.next.current, r.next.previous, r.next.trying, r.next.bad],
      ["0.2.0", "0.3.0", "0.2.0", null, "0.2.0", ["0.3.0"]],
    )
    // And when 0.2.0 doesn't come up either, the tarball's own server runs.
    r = choose(r.next, "0.1.0")
    assert.deepStrictEqual([r.pick, r.next.trying, r.next.bad], [null, null, ["0.3.0", "0.2.0"]])
    // A version without its files isn't picked.
    assert.isNull(choose(state({ current: "0.4.0" }), "0.1.0").pick)
  })

  it("a_newer_packages_server_takes_over_from_the_versions_downloaded_before_it", () => {
    const s = superseded(state({ current: "0.0.0-old", previous: "0.0.0-a", bad: ["0.0.0-b"] }), v("0.1.0"))
    assert.deepStrictEqual([s.current, s.previous, s.bad], [null, null, ["0.0.0-b"]])
    const kept = superseded(state({ current: "0.2.0", previous: "0.0.1" }), v("0.1.0"))
    assert.deepStrictEqual([kept.current, kept.previous], ["0.2.0", null])
  })

  it("rollback_and_putting_it_back_keep_what_a_download_staged_meanwhile", () => {
    const before = state({ current: "0.2.0", previous: "0.1.5", staged: "0.2.5", bad: ["0.0.9"] })
    const rolled = rolledBack(before, "0.2.0", "0.1.5")
    assert.deepStrictEqual([rolled.current, rolled.previous, rolled.bad], ["0.1.5", null, ["0.0.9", "0.2.0"]])
    // A download stages 0.3.0 while the rollback execs, which fails.
    const back = notRolledBack({ ...rolled, staged: "0.3.0" }, before, "0.2.0", "0.1.5")
    assert.deepStrictEqual(toRecord(back), toRecord({ ...before, staged: "0.3.0" }))
    // To the bundled server.
    const bundled = rolledBack(state({ current: "0.2.0", trying: "0.2.0" }), "0.2.0", null)
    assert.deepStrictEqual([bundled.current, bundled.trying, bundled.bad], [null, null, ["0.2.0"]])
  })
})

describe("the commit a server reports", () => {
  it("a_release_reports_the_commit_it_was_built_from", () => {
    assert.strictEqual(pickCommit("built", "bundle", false), "built")
    assert.strictEqual(pickCommit("built", "bundle", true), "built")
    // A build that doesn't know its commit: a deployment goes by HUNTAWAY_COMMIT, a release by none.
    assert.strictEqual(pickCommit(null, "bundle", false), "bundle")
    assert.strictEqual(pickCommit(" ", " bundle\n", false), "bundle")
    assert.isNull(pickCommit(null, "bundle", true))
    assert.isNull(pickCommit(null, "", false))
  })
})
