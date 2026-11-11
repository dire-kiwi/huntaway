import { afterAll, assert, describe, it } from "vite-plus/test"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { FAKE_GH } from "@huntaway/testing"

// `huntaway gh-run` (docs/plan/inventory/03-mcp.md 2.13): gh in a wait's command as the task's GitHub account, run as a
// wait's shim runs it, through bin/huntaway, against the fake gh. The old server had no test of its own for it (its
// parts were the gh tools'); these hold what it shares with them: the refusals, the host check, the account's own
// token in a config folder that goes after, and gh's exit code.

const BIN = fileURLToPath(new URL("../../bin/huntaway", import.meta.url))

const dirs: Array<string> = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** A fake GitHub in a temp folder: the gh to run, its state's file, and where gh-run makes its config folders. */
const fakeGitHub = () => {
  const dir = mkdtempSync(join(tmpdir(), "huntaway-gh-run-"))
  dirs.push(dir)
  const state = join(dir, "github.json")
  writeFileSync(
    state,
    JSON.stringify({
      accounts: [
        { host: "github.com", login: "me", token: "tok-me" },
        { host: "github.com", login: "other", token: "tok-other", active: true },
      ],
      repos: { "o/r": { pulls: [{ number: 1, title: "The change", body: "", state: "OPEN", head: "x", base: "main" }] } },
    }),
  )
  const gh = join(dir, "gh")
  writeFileSync(gh, `#!/bin/sh\nHUNTAWAY_FAKE_GH_STATE='${state}' exec '${FAKE_GH}' "$@"\n`)
  chmodSync(gh, 0o755)
  return { gh, state, root: join(dir, "gh-account") }
}

interface Call {
  readonly args: ReadonlyArray<string>
  readonly as: string | null
  readonly envToken: boolean
  readonly configDir: string | null
}

const callsOf = (state: string): ReadonlyArray<Call> => {
  const parsed: { readonly calls?: ReadonlyArray<Call> } = JSON.parse(readFileSync(state, "utf8"))
  return parsed.calls ?? []
}

const ghRun = (fake: ReturnType<typeof fakeGitHub>, account: string | null, args: ReadonlyArray<string>) =>
  spawnSync(BIN, ["gh-run", ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...(account === null ? {} : { HUNTAWAY_GH_ACCOUNT: account }),
      HUNTAWAY_GH_BIN: fake.gh,
      HUNTAWAY_GH_CONFIG_ROOT: fake.root,
      GH_TOKEN: "ambient",
    },
  })

describe("gh-run", () => {
  it("runs gh as the account, with its own token in a config folder that goes after", () => {
    const fake = fakeGitHub()
    const out = ghRun(fake, "me", ["pr", "view", "1", "--repo", "o/r", "--json", "title"])
    assert.strictEqual(out.status, 0, out.stderr)
    assert.include(out.stdout, '"title": "The change"')
    const view = callsOf(fake.state).find((c) => c.args[0] === "pr" && !c.args.includes("--help"))
    assert.strictEqual(view?.as, "me")
    assert.isFalse(view?.envToken, "a token from the environment reached gh")
    assert.isTrue(view?.configDir?.startsWith(fake.root))
    assert.isFalse(existsSync(view?.configDir ?? "/nonexistent"), "its config folder is still there")
  })

  it("passes gh's own exit code on", () => {
    const fake = fakeGitHub()
    const out = ghRun(fake, "me", ["pr", "view", "99", "--repo", "o/r"])
    assert.strictEqual(out.status, 1)
    assert.include(out.stderr, "Could not resolve to a PullRequest with the number of 99")
  })

  it("refuses what the gh tools refuse, and other hosts, before gh runs as the account", () => {
    const fake = fakeGitHub()
    for (const [args, why] of [
      [["auth", "token"], "gh auth isn't available to agents"],
      [["extension", "install", "o/gh-x"], "gh extension isn't available to agents"],
      [["api", "https://evil.example.com/user"], "only reach github.com: not evil.example.com"],
      [["pr", "list", "-R", "ghe.example.com/o/r"], "not ghe.example.com"],
    ] as const) {
      const out = ghRun(fake, "me", args)
      assert.strictEqual(out.status, 1, args.join(" "))
      assert.include(out.stderr, why, args.join(" "))
    }
    // Only gh's help ran: nothing as the account.
    assert.isTrue(callsOf(fake.state).every((c) => c.args.includes("--help")))
    const none = ghRun(fake, null, ["pr", "list"])
    assert.strictEqual(none.status, 1)
    assert.include(none.stderr, "HUNTAWAY_GH_ACCOUNT isn't set")
    // An account gh isn't signed in to never runs as another.
    const missing = ghRun(fake, "nobody", ["pr", "list", "--repo", "o/r"])
    assert.strictEqual(missing.status, 1)
    assert.include(missing.stderr, "the GitHub account nobody isn't signed in to gh on this host")
    assert.isFalse(callsOf(fake.state).some((c) => c.args[0] === "pr" && !c.args.includes("--help")))
  })
})
