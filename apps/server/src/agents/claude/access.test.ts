import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { ghHook, hookSettings } from "../rules.ts"
import {
  approvesOwnWaits,
  boardToolsAllowed,
  cacheDirsIn,
  codexEffort,
  GH_READ_ONLY,
  ghAllowed,
  githubAccount,
  noRunTools,
  reviewFilesystem,
  usesServer,
} from "./access.ts"
import type { CodexModel } from "./access.ts"

// huntaway's agent/runner/access.test.ts, the cases of the pure rules. Left to the Codex driver (M5), as they run git
// or list Codex's models: many_long_ignored_directories_dont_block_the_launch, a_reviewer_may_write_the_directories_git_
// ignores_whole, and the second half of an_effort_a_codex_model_doesnt_take_gives_way_to_its_default (codex_run_effort).
// caches_are_writable_before_their_first_use keeps its paths; making them is the caller's.

/** The board server's tool names, as a review thread's and another's manifest list them (a few of each). */
const TOOLS = ["list_tasks", "get_task", "get_task_field", "create_task", "wait"]
const REVIEW_TOOLS = ["get_task", "get_task_field", "wait", "submit_review"]

/** Where the environment moves the caches. */
const env = (k: string) => ({ XDG_CACHE_HOME: "/h/xdg/cache", XDG_DATA_HOME: "/h/xdg/data", CARGO_HOME: "/h/cargo" })[k] ?? ""

const model = (id: string, is_default: boolean, efforts: ReadonlyArray<string>, default_effort: string | null): CodexModel => ({
  id,
  is_default,
  efforts,
  default_effort,
})

const args = (mode: "default" | "acceptEdits" | "plan" | "dontAsk" | "bypassPermissions" | "auto", review: boolean) => [
  "-p",
  "--permission-mode",
  mode,
  "--allowedTools",
  ...boardToolsAllowed(mode, review ? REVIEW_TOOLS : TOOLS),
  "mcp__gh__pr_view",
  "--disallowedTools",
  "mcp__gh__pr_merge",
  "--add-dir",
  "/a",
]

const old = (mode: string, allowed: string) => ["-p", "--permission-mode", mode, "--allowedTools", allowed, "mcp__gh__pr_view", "--add-dir", "/a"]

describe("access", () => {
  it("caches are where the environment says, else in the home folder", () => {
    assert.deepStrictEqual(
      cacheDirsIn("/h", () => null),
      ["/h/.cache", "/h/.npm", "/h/.cargo/registry", "/h/.cargo/git", "/h/.local/share/pnpm"],
    )
    assert.deepStrictEqual(cacheDirsIn("/h", env), ["/h/xdg/cache", "/h/.npm", "/h/cargo/registry", "/h/cargo/git", "/h/xdg/data/pnpm"])
  })

  it("a reviewer's work stays read-only inside a cache", () => {
    const fs = reviewFilesystem(["/home/me/.cache", "/home/me/.cache/w/target"], ["/home/me/.cache/w", "/home/me/.cache/repo/.git"])
    assert.deepStrictEqual(Object.entries(fs), [
      ["/home/me/.cache", "write"],
      ["/home/me/.cache/repo/.git", "read"],
      ["/home/me/.cache/w", "read"],
      ["/home/me/.cache/w/target", "write"],
    ])
  })

  it("only merging tasks merge without asking", () => {
    assert.deepStrictEqual(ghAllowed({ merging: false, kind: "task" }), GH_READ_ONLY)
    assert.deepStrictEqual(ghAllowed({ merging: true, kind: "task" }), [...GH_READ_ONLY, "pr_merge"])
    assert.isFalse(ghAllowed({ merging: true, kind: "review" }).includes("pr_merge"))
  })

  it("an effort a Codex model doesn't take gives way to its default", () => {
    const models = [
      model("gpt-5.5", true, ["low", "medium", "high", "xhigh"], "medium"),
      model("gpt-6", false, ["low", "max"], null),
      model("odd", false, [], null),
    ]
    const e = (effort: string, m: string | null) => codexEffort(effort, m, models)
    assert.strictEqual(e("max", "gpt-5.5"), "medium")
    assert.strictEqual(e("high", "gpt-5.5"), "high")
    // No model: the default one's.
    assert.strictEqual(e("max", null), "medium")
    assert.strictEqual(e("max", "gpt-6"), "max")
    assert.strictEqual(e("high", "gpt-6"), null, "no default of its own: Codex picks")
    // A model it doesn't know, or one that doesn't list its efforts, keeps it.
    assert.strictEqual(e("max", "gpt-7"), "max")
    assert.strictEqual(e("max", "odd"), "max")
    assert.strictEqual(codexEffort(null, "gpt-5.5", models), null)
  })

  it("the GitHub account is the project's or the profile's", () => {
    assert.strictEqual(githubAccount({ github_account: null }, { github_account: null }), null)
    assert.strictEqual(githubAccount({ github_account: null }, { github_account: "me" }), "me")
    assert.strictEqual(githubAccount(null, { github_account: "me" }), "me")
    assert.strictEqual(githubAccount({ github_account: "work-me" }, { github_account: "me" }), "work-me")
    assert.strictEqual(githubAccount({ github_account: " " }, { github_account: "me" }), "me")
  })

  it.effect("the gh hook runs this binary, unless the project turns the gh server off or has its own", () =>
    Effect.gen(function* () {
      const settings = yield* hookSettings([ghHook("/opt/it's here/huntaway")])
      assert.strictEqual(
        settings,
        `{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"'/opt/it'\\\\''s here/huntaway' gh-hook","timeout":10}]}]}}`,
      )
      assert.isTrue(usesServer(noRunTools, "gh", true))
      assert.isFalse(usesServer({ ...noRunTools, disallowed: ["mcp__gh"] }, "gh", true))
      assert.isFalse(usesServer({ ...noRunTools, mcp_servers: { gh: {} } }, "gh", true))
      // Nor when the board doesn't serve it.
      assert.isFalse(usesServer(noRunTools, "gh", false))
    }),
  )

  it("in auto mode Claude reviews waits itself", () => {
    for (const mode of ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"] as const) {
      assert.deepStrictEqual(boardToolsAllowed(mode, TOOLS), ["mcp__huntaway"])
      assert.isFalse(approvesOwnWaits(args(mode, false)), mode)
    }
    for (const review of [false, true]) {
      const auto = boardToolsAllowed("auto", review ? REVIEW_TOOLS : TOOLS)
      assert.isTrue(auto.includes("mcp__huntaway__get_task") && auto.includes("mcp__huntaway__get_task_field"))
      assert.isFalse(auto.some((t) => t === "mcp__huntaway__wait" || t === "mcp__huntaway"))
      assert.strictEqual(auto.includes("mcp__huntaway__submit_review"), review)
      assert.isTrue(approvesOwnWaits(args("auto", review)))
    }
    // Runs started by an older build had every board tool pre-approved, under the board's current or (before the
    // rename) old server name, whatever their mode.
    for (const mode of ["auto", "default", "dontAsk", "plan"]) {
      for (const allowed of ["mcp__huntaway", "mcp__issue_agent", "mcp__issue_agent__wait", "mcp__gh__pr_list,mcp__issue_agent"]) {
        assert.isFalse(approvesOwnWaits(old(mode, allowed)), `${mode} ${allowed}`)
      }
    }
    // Only auto mode leaves waits to Claude, however the board tools are listed.
    assert.isTrue(approvesOwnWaits(old("auto", "mcp__huntaway__get_task")))
    for (const mode of ["default", "dontAsk", "plan", "acceptEdits", "bypassPermissions"])
      assert.isFalse(approvesOwnWaits(old(mode, "mcp__huntaway__get_task")), mode)
    // A Codex run's arguments are the adapter's.
    assert.isFalse(approvesOwnWaits(["codex-run", "/runs/r/codex.json"]))
    assert.isFalse(approvesOwnWaits([]))
  })
})
