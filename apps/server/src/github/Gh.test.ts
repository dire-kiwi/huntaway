import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { createServer } from "node:net"
import { dashC, extraHeaderResets, gitCredentialConfig, parseAccount } from "@huntaway/shared"
import { fakeGitHub, fakePull, git, tempDir, TestPlatform } from "@huntaway/testing"
import type { FakeGitHub, FakeGitHubState } from "@huntaway/testing"
import { Git } from "../git/Git.ts"
import { GitHubAccess } from "../git/GitHubAccess.ts"
import { DataDir } from "../platform/DataDir.ts"
import type { ServerConfigShape } from "../platform/ServerConfig.ts"
import { Gh, MergePoll } from "./Gh.ts"
import type { GhRun } from "./Gh.ts"
import { GitHubAccessLive } from "./GitHubAccessLive.ts"

// huntaway's mcp/gh_mcp/tests.test.ts, the cases that run gh and git (the pure ones are gh/commands.test.ts and
// packages/shared's test/gh.test.ts), against the fake gh (`fakeGitHub`) and repositories in temp folders:
// `gh_acts_as_the_account_and_no_other` (its folder: made private, removed after), `gh_reads_its_own_help_for_the_check`,
// `a_waits_shell_gets_gh_through_gh_run_and_no_token`, `pushes_are_checked_at_every_url_git_would_push_to`,
// `pushes_send_no_configured_authorization_header`, `fetches_use_only_the_selected_accounts_https_credentials`,
// `pushes_with_the_accounts_token_over_https`, `a_merge_the_board_hasnt_approved_never_runs_gh`,
// `runs_gh_and_reports_failures`, `pr_merge_merges_a_stacked_pull_request_with_merge_async`,
// `pushes_dont_run_the_repositorys_hooks`, `pushes_to_a_path_on_this_machine_are_refused`, `pushes_dont_push_submodules`,
// `the_gh_tool_refuses_alternate_refs_commands_and_submodules`,
// `a_repositorys_own_config_cant_run_a_command_through_the_gh_tools`, `a_push_over_ssh_has_no_token_in_its_environment`.
// Dropped: `gh_sends_the_token_to_the_accounts_host_only`, which ran the real gh against `.invalid` hosts (tests never
// run the real gh; where a command goes is checked before gh runs, packages/shared's cases).

/** git as the user has it, but none of the user's own configuration: what the board's git runs with here. */
const PLAIN_GIT = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }

const GhLive = (overrides: Partial<ServerConfigShape>) =>
  Layer.mergeAll(Gh.layer, GitHubAccessLive.pipe(Layer.provideMerge(Gh.layer))).pipe(Layer.provideMerge(Git.layer), Layer.provideMerge(TestPlatform(overrides)))

/** `body` with `Gh` over a fake GitHub of `state`, and the server's configuration changed by `overrides`. */
const withGitHub = <A, E, R>(state: FakeGitHubState, body: (fake: FakeGitHub) => Effect.Effect<A, E, R>, overrides: Partial<ServerConfigShape> = {}) =>
  Effect.gen(function* () {
    const fake = yield* fakeGitHub(state)
    return yield* body(fake).pipe(Effect.provide(GhLive({ ghBin: fake.bin, agentEnv: PLAIN_GIT, ...overrides })))
  }).pipe(Effect.provide(NodeServices.layer))

const runIn = (cwd: string | null, account: string | null = null, gate: string | null = null): GhRun => ({
  cwd,
  account: account === null ? null : parseAccount(account),
  mergeGate: Effect.succeed(gate),
})

const ME = { host: "github.com", login: "me", token: "tok-me" }
const OTHER = { host: "github.com", login: "other", token: "tok-other", active: true }

/** What a call was refused with. */
const refusal = <A, R>(effect: Effect.Effect<A, { readonly message: string }, R>) => Effect.map(Effect.flip(effect), (e) => e.message)

const exists = (path: string) => Effect.flatMap(FileSystem.FileSystem, (fs) => fs.exists(path)).pipe(Effect.orDie)
const write = (path: string, text: string, mode?: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(path, text)
    if (mode !== undefined) yield* fs.chmod(path, mode)
  }).pipe(Effect.orDie)
const read = (path: string) => Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(path)).pipe(Effect.orDie)

/** A repository at `<dir>/work` on branch main with a commit, and a bare one at `<dir>/remote.git`. */
const workAndBare = (dir: string) =>
  Effect.gen(function* () {
    const bare = `${dir}/remote.git`
    const work = `${dir}/work`
    yield* git(dir, ["init", "-q", "--bare", bare])
    yield* git(dir, ["init", "-q", "-b", "main", work])
    yield* git(work, ["commit", "-q", "--allow-empty", "-m", "x"])
    return { work, bare }
  })

/** The user's own SSH command (theirs, not the repository's): a script that serves a push from `bare`, logging what it was asked for. */
const fakeSsh = (dir: string, bare: string, log: string) =>
  Effect.gen(function* () {
    const ssh = `${dir}/fake-ssh`
    yield* write(ssh, `#!/bin/sh\nfor a; do last="$a"; done\necho "$last" >> '${log}'\nexec git receive-pack '${bare}'\n`, 0o755)
    return { ...PLAIN_GIT, GIT_SSH_COMMAND: ssh, GIT_SSH_VARIANT: "ssh" }
  })

/** `git <args>` in `cwd` with `env` (over the test's) and `stdin`: what it printed. */
const gitWith = (cwd: string, args: ReadonlyArray<string>, env: Readonly<Record<string, string | undefined>>, stdin = "") =>
  Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
    spawner.string(ChildProcess.make("git", args, { cwd, env, extendEnv: true, stdin: Stream.make(new TextEncoder().encode(stdin)), stderr: "ignore" })),
  ).pipe(Effect.orDie)

describe("Gh", () => {
  it.effect("acts as the task's account and no other, with a config folder of its own that goes after", () =>
    withGitHub(
      { accounts: [ME, OTHER], repos: { "o/r": { pulls: [fakePull({ number: 1, head: "x" })] } } },
      (fake) =>
        Effect.gen(function* () {
          const gh = yield* Gh
          const out = yield* gh.run("pr_view", { pr: "1", repo: "o/r" }, runIn(null, "me"))
          assert.isFalse(out.failed, out.text)
          assert.include(out.text, '"title": "PR 1"')
          // gh's help (for the check of where it goes) aside.
          const calls = (yield* fake.calls).filter((c) => !c.args.includes("--help"))
          // Its token from gh's own logins, with no token from the environment.
          assert.deepStrictEqual(calls[0]?.args, ["auth", "token", "--hostname=github.com", "--user=me"])
          const view = calls[1]
          assert.strictEqual(view?.as, "me")
          assert.isFalse(view?.envToken)
          assert.deepStrictEqual([view?.host, view?.repo], ["github.com", "o/r"])
          // Readable by this user only, and gone once gh is done.
          assert.deepStrictEqual(view?.configModes, ["700", "600"])
          if (process.platform === "linux") assert.strictEqual(view?.dbus, "disabled:")
          assert.isFalse(yield* exists(view?.configDir ?? "/nonexistent"))
          // Without an account, gh's active one, as gh has it.
          yield* gh.run("pr_view", { pr: "1", repo: "o/r" }, runIn(null))
          const plain = (yield* fake.calls).at(-1)
          assert.deepStrictEqual([plain?.as, plain?.configDir], ["other", null])
          // An account gh isn't signed in to is never another.
          const why = yield* refusal(gh.run("pr_view", { pr: "1", repo: "o/r" }, runIn(null, "nobody")))
          assert.include(why, "the GitHub account nobody isn't signed in to gh on this host")
        }),
      { agentEnv: { ...PLAIN_GIT, GH_TOKEN: "ambient", GITHUB_TOKEN: "ambient" } },
    ),
  )

  it.effect("checks where a command goes with gh's own help, read once", () =>
    withGitHub(
      {
        accounts: [ME],
        help: {
          "pr view": "USAGE\n  gh pr view [<number> | <url> | <branch>] [flags]\n\nFLAGS\n  -c, --comments   View pull request comments\n",
          "repo edit": "USAGE\n  gh repo edit [<repository>] [flags]\n\nFLAGS\n  -h, --homepage URL   Repository home page URL\n",
        },
      },
      (fake) =>
        Effect.gen(function* () {
          const gh = yield* Gh
          const r = runIn(null, "me")
          assert.include(yield* refusal(gh.run("gh", { args: ["pr", "view", "https://evil.example.com/o/r/pull/1"] }, r)), "not evil.example.com")
          assert.include(yield* refusal(gh.run("gh", { args: ["pr", "view", "-c", "https://evil.example.com/o/r/pull/2"] }, r)), "not evil.example.com")
          // A homepage is content, not where the command goes.
          yield* gh.run("gh", { args: ["repo", "edit", "o/r", "--homepage", "https://example.com"] }, r)
          const asked = (yield* fake.calls).filter((c) => c.args.includes("--help")).map((c) => c.args.join(" "))
          assert.deepStrictEqual(asked, ["pr view --help", "repo edit --help"])
        }),
    ),
  )

  // HA-86 review: `pr --repo=o/r merge` got past the check and merged while approval was pending.
  it.effect("a merge the board hasn't approved never runs gh", () =>
    withGitHub({ accounts: [OTHER], repos: { "o/r": { pulls: [fakePull({ number: 1, head: "x" })] } } }, (fake) =>
      Effect.gen(function* () {
        const gh = yield* Gh
        const r = runIn(null, null, "Merging is disabled: not approved")
        for (const [tool, a] of [
          ["gh", { args: ["pr", "--repo=o/r", "merge", "1", "--merge"] }],
          ["gh", { args: ["pr", "-R", "o/r", "merge", "1"] }],
          ["gh", { args: ["pr", "merge", "1", "--repo", "o/r"] }],
          ["api", { endpoint: "repos/o/r/pulls/1/merge", method: "PUT" }],
          ["gh", { args: ["api", "graphql", "--method", "POST", "--input", "/x/payload.json"] }],
          ["gh", { args: ["api", "graphql", "-F", "query=@/x/query.graphql"] }],
          ["pr_merge", { pr: "https://github.com/o/r/pull/1" }],
        ] as const) {
          const out = yield* gh.run(tool, a, r)
          assert.isTrue(out.failed && out.text.includes("not approved"), `${tool}: ${out.text}`)
        }
        assert.deepStrictEqual(yield* fake.calls, [], "gh ran")
        // What doesn't merge runs.
        assert.isFalse((yield* gh.run("gh", { args: ["pr", "view", "1", "--repo", "o/r"] }, r)).failed)
        assert.strictEqual((yield* fake.calls).length, 1)
        assert.strictEqual((yield* fake.pull("o/r", 1))?.state, "OPEN")
      }),
    ),
  )

  it.effect("runs gh, reporting a failure with gh's exit and nothing printed as Done.", () =>
    withGitHub(
      {
        accounts: [OTHER],
        routes: { "release list": { stdout: "" } },
        repos: { "o/r": { pulls: [fakePull({ number: 2, head: "y", checks: [{ name: "ci", state: "PENDING", bucket: "pending" }] })] } },
      },
      () =>
        Effect.gen(function* () {
          const gh = yield* Gh
          const failed = yield* gh.run("gh", { args: ["no-such-command"] }, runIn(null))
          assert.isTrue(failed.failed)
          assert.include(failed.text, 'unknown command "no-such-command" for "gh"\n\n(gh exited with exit status: 1)')
          assert.deepStrictEqual(yield* gh.run("gh", { args: ["release", "list"] }, runIn(null)), { text: "Done.", failed: false })
          // gh pr checks exits 8 while checks are pending.
          const checks = yield* gh.run("pr_checks", { pr: "2", repo: "o/r" }, runIn(null))
          assert.isFalse(checks.failed, checks.text)
          assert.include(checks.text, '"bucket": "pending"')
          assert.include(yield* refusal(gh.run("pr_view", {}, runIn("/nonexistent/dir"))), "/nonexistent/dir is not a directory")
        }),
    ),
  )

  // HA-336: GitHub's legacy merge (gh pr merge) refuses a pull request in a stack, so pr_merge merges one with the
  // merge-async API and waits for it; it won't merge one with unmerged pull requests below it in its stack, which GitHub
  // would merge too. One that isn't in a stack merges as before.
  it.effect("pr_merge merges a stacked pull request with merge-async", () =>
    withGitHub(
      {
        accounts: [OTHER],
        repos: {
          "o/r": {
            pulls: [
              fakePull({ number: 6, head: "a", stack: 4, state: "MERGED", merged_at: "2026-11-09T00:00:00Z" }),
              fakePull({ number: 7, head: "b", stack: 4, mergeAsync: "pending" }),
              fakePull({ number: 8, head: "c", stack: 5 }),
              fakePull({ number: 9, head: "d" }),
            ],
            // #7 is on #6 (merged) in stack 4, #8 on #7 (open) in stack 5; #9 isn't in one.
            stacks: { "4": [6, 7], "5": [7, 8] },
          },
        },
      },
      (fake) =>
        Effect.gen(function* () {
          const gh = yield* Gh
          const r = runIn(null)
          const merge = (a: Readonly<Record<string, unknown>>) =>
            gh.run("pr_merge", a, r).pipe(Effect.provideService(MergePoll, { every: "0 millis", for: "1 minute" }))
          let out = yield* merge({ pr: "https://github.com/o/r/pull/8" })
          assert.isTrue(out.failed && out.text.startsWith("#7, below #8 in its stack on GitHub, isn't merged yet"), out.text)
          out = yield* merge({ pr: "https://github.com/o/r/pull/7", auto: true })
          assert.isTrue(out.failed && out.text.includes("doesn't auto-merge those yet"), out.text)
          out = yield* merge({ pr: "https://github.com/o/r/pull/7", method: "squash" })
          assert.isTrue(!out.failed && out.text.startsWith("Merged #7 (in a stack on GitHub, #4"), out.text)
          assert.deepStrictEqual([(yield* fake.pull("o/r", 7))?.state, (yield* fake.pull("o/r", 7))?.mergeMethod], ["MERGED", "squash"])
          out = yield* merge({ pr: "https://github.com/o/r/pull/9" })
          assert.isFalse(out.failed, out.text)
          // The legacy merge only for the one that isn't stacked, and no merge of #8 (or #7 with it).
          const merges = (yield* fake.calls).map((c) => c.args.join(" ")).filter((c) => c.includes("merge") && !c.startsWith("pr view"))
          assert.deepStrictEqual(merges, [
            "api -X PUT repos/o/r/pulls/7/merge-async -f merge_method=squash",
            "api repos/o/r/pulls/7/merge-async/u7",
            "pr merge 9 --repo=o/r --merge",
          ])
        }),
    ),
  )

  it.effect("a wait's shell gets gh through gh-run, and no token", () =>
    Effect.gen(function* () {
      const exe = "/opt/it's/huntaway"
      yield* withGitHub(
        { accounts: [{ host: "ghe.example.com", login: "me", token: "tok" }] },
        (fake) =>
          Effect.gen(function* () {
            const gh = yield* Gh
            const shim = `${(yield* DataDir).root}/gh-shim`
            const env = yield* gh.shellEnv("ghe.example.com/me")
            assert.isTrue(env["PATH"]?.startsWith(`${shim}:`))
            assert.strictEqual(env["HUNTAWAY_GH_ACCOUNT"], "ghe.example.com/me")
            assert.strictEqual(env["HUNTAWAY_GH_BIN"], fake.bin)
            // The token stays with gh-run.
            assert.isTrue(Object.entries(env).every(([k, v]) => !["GH_TOKEN", "GITHUB_TOKEN"].includes(k) && v !== "tok"))
            assert.strictEqual(yield* read(`${shim}/gh`), "#!/bin/sh\nexec '/opt/it'\\''s/huntaway' gh-run \"$@\"\n")
            const info = yield* Effect.flatMap(FileSystem.FileSystem, (fs) => fs.stat(`${shim}/gh`)).pipe(Effect.orDie)
            assert.strictEqual(info.mode & 0o777, 0o755)
            assert.deepStrictEqual(yield* gh.shellEnv(null), {})
            assert.include(yield* refusal(gh.shellEnv("ghe.example.com/missing")), "isn't signed in to gh")
          }),
        { exe },
      )
    }),
  )

  it.effect("pushes are checked at every URL git would push to", () =>
    withGitHub({ accounts: [ME] }, () =>
      Effect.gen(function* () {
        const gh = yield* Gh
        const dir = yield* tempDir
        const { work } = yield* workAndBare(dir)
        yield* git(work, ["remote", "add", "two", "git@github.com:o/r.git"])
        yield* git(work, ["config", "--add", "remote.two.pushurl", "git@github.com:o/r.git"])
        yield* git(work, ["config", "--add", "remote.two.pushurl", "https://evil.example.com/o/r.git"])
        yield* git(work, ["remote", "add", "rewritten", "https://ghe.example.com/o/r.git"])
        yield* git(work, ["config", "url.https://evil.example.com/.pushInsteadOf", "https://ghe.example.com/"])
        // Logins in a URL, which git would use instead of the account's token.
        yield* git(work, ["remote", "add", "login", "https://other:other-token@github.com/o/r.git"])
        yield* git(work, ["remote", "add", "user", "https://other@github.com/o/r.git"])
        const push = (remote: string) => refusal(gh.run("git_push", { remote, branch: "main" }, runIn(work, "me")))
        // Every push URL, and as git rewrites it.
        assert.include(yield* push("two"), "not evil.example.com")
        assert.include(yield* push("rewritten"), "not evil.example.com")
        assert.include(yield* push("login"), "has a login in it")
        assert.include(yield* push("user"), "has a login in it")
        // A URL isn't a remote's name: git would rewrite it too.
        assert.include(yield* push("https://github.com/o/r.git"), "there's no remote named https://github.com/o/r.git")
        assert.include(yield* push("--all"), "bad remote or branch")
      }),
    ),
  )

  // HA-341: git_push ran the repository's own hooks outside the agent's sandbox, and the agent can write them.
  it.effect("pushes don't run the repository's hooks", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir
      const { work, bare } = yield* workAndBare(dir)
      yield* git(work, ["remote", "add", "origin", "ssh://git@example.invalid/o/r.git"])
      const ran = `${dir}/ran`
      for (const hook of ["pre-push", "reference-transaction"]) yield* write(`${work}/.git/hooks/${hook}`, `#!/bin/sh\ntouch '${ran}'\n`, 0o755)
      const env = yield* fakeSsh(dir, bare, `${dir}/log`)
      yield* withGitHub(
        {},
        () =>
          Effect.gen(function* () {
            const out = yield* (yield* Gh).run("git_push", { branch: "main", dir: work }, runIn(work))
            assert.isFalse(out.failed, out.text)
          }),
        { agentEnv: env },
      )
      assert.isFalse(yield* exists(ran), "a hook ran")
      assert.match(yield* git(bare, ["rev-parse", "main"]), /^[0-9a-f]{40}$/)
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  // HA-341 review: a push to a path on this machine runs git there without the config the tools give it, so the hooks
  // of a repository the agent made and named as a push URL ran.
  it.effect("pushes to a path on this machine are refused", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir
      const { work, bare } = yield* workAndBare(dir)
      const ran = `${dir}/ran`
      yield* write(`${bare}/hooks/pre-receive`, `#!/bin/sh\nenv > '${ran}'\n`, 0o755)
      yield* withGitHub({}, () =>
        Effect.gen(function* () {
          for (const url of [bare, `file://${bare}`]) {
            yield* git(work, ["remote", "remove", "origin"]).pipe(Effect.ignore)
            yield* git(work, ["remote", "add", "origin", url])
            const out = yield* (yield* Gh).run("git_push", { branch: "main" }, runIn(work))
            assert.isTrue(out.failed && out.text.includes("not allowed"), `${url}: ${out.text}`)
            assert.isFalse(yield* exists(ran), `${url}: its hook ran`)
          }
        }),
      )
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  // HA-341 review: a push into submodules used their own config, which isn't checked (here, their SSH command).
  it.effect("pushes don't push submodules", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir
      const { work, bare } = yield* workAndBare(dir)
      yield* Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeDirectory(`${dir}/sub`)).pipe(Effect.orDie)
      const { work: subSource } = yield* workAndBare(`${dir}/sub`)
      yield* git(work, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", subSource, "sub"])
      const sub = `${work}/sub`
      yield* git(sub, ["remote", "set-url", "origin", "ssh://git@example.invalid/sub.git"])
      yield* git(sub, ["commit", "-q", "--allow-empty", "-m", "unpushed"])
      yield* git(work, ["commit", "-q", "-am", "sub moved"])
      yield* git(work, ["remote", "add", "origin", "ssh://git@example.invalid/o/r.git"])
      yield* git(work, ["config", "push.recurseSubmodules", "on-demand"])
      const log = `${dir}/log`
      const env = yield* fakeSsh(dir, bare, log)
      const out = yield* withGitHub({}, () => Effect.flatMap(Gh, (gh) => gh.run("git_push", { branch: "main" }, runIn(work))), { agentEnv: env })
      const asked = yield* read(log)
      assert.notInclude(asked, "sub.git", `the submodule was pushed: ${asked} ${out.text}`)
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  // HA-341 review: more settings that run a command (here on a fetch, as gh pr checkout and gh repo sync do), and
  // submodules (gh pr checkout --recurse-submodules), whose own config isn't checked.
  it.effect("the gh tool refuses alternate refs commands and submodules", () =>
    withGitHub({}, () =>
      Effect.gen(function* () {
        const gh = yield* Gh
        const dir = yield* tempDir
        const { work } = yield* workAndBare(dir)
        const call = (a: ReadonlyArray<string>) => refusal(gh.run("gh", { args: a }, runIn(work)))
        yield* git(work, ["config", "core.alternateRefsCommand", "touch x"])
        assert.include(yield* call(["repo", "sync"]), "core.alternaterefscommand")
        yield* git(work, ["config", "--unset", "core.alternateRefsCommand"])
        yield* git(work, ["config", "submodule.sub.update", "!touch x"])
        assert.include(yield* call(["repo", "sync"]), "submodule.sub.update")
        yield* git(work, ["config", "--unset", "submodule.sub.update"])
        assert.include(yield* call(["pr", "checkout", "1", "--recurse-submodules"]), "--recurse-submodules")
      }),
    ),
  )

  // HA-341 review: the repository's own config could still choose the command git runs (`core.sshCommand` for an SSH
  // remote, among others), outside the sandbox and with the account's token in its environment.
  it.effect("a repository's own config can't run a command through the gh tools", () =>
    withGitHub({}, () =>
      Effect.gen(function* () {
        const gh = yield* Gh
        const dir = yield* tempDir
        const { work } = yield* workAndBare(dir)
        yield* git(work, ["remote", "add", "origin", "ssh://git@127.0.0.1:1/o/r.git"])
        const ran = `${dir}/ran`
        yield* git(work, ["config", "core.sshCommand", `sh -c 'env > ${ran}' --`])
        const r = runIn(work)
        assert.include(yield* refusal(gh.run("git_push", { branch: "main" }, r)), "core.sshcommand")
        assert.isFalse(yield* exists(ran), "the repository's ssh command ran")
        // gh's calls there too, and the other settings that run a command or redirect git.
        assert.include(yield* refusal(gh.run("gh", { args: ["pr", "view", "1"] }, r)), "core.sshcommand")
        yield* git(work, ["config", "--unset", "core.sshCommand"])
        for (const [k, v] of [
          ["remote.origin.receivepack", "touch x"],
          ["http.proxy", "http://127.0.0.1:1"],
          ["http.https://github.com/.sslVerify", "false"],
          ["protocol.ext.allow", "always"],
        ] as const) {
          yield* git(work, ["config", k, v])
          assert.include(yield* refusal(gh.run("git_push", { branch: "main" }, r)), k.toLowerCase())
          yield* git(work, ["config", "--unset", k])
        }
      }),
    ),
  )

  // HA-341 review: the account's token was in the environment of every push, an SSH one's SSH command included.
  it.effect("a push over SSH has no token in its environment", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir
      const { work } = yield* workAndBare(dir)
      yield* git(work, ["remote", "add", "origin", "ssh://git@github.com/o/r.git"])
      // The user's own SSH command: it sees what git gives it, and fails the push.
      const seen = `${dir}/seen`
      yield* withGitHub(
        { accounts: [ME] },
        () =>
          Effect.gen(function* () {
            const out = yield* (yield* Gh).run("git_push", { branch: "main" }, runIn(work, "me"))
            assert.isTrue(out.failed)
          }),
        { agentEnv: { ...PLAIN_GIT, GIT_SSH_COMMAND: `sh -c 'env > ${seen}; exit 1' --` } },
      )
      assert.isTrue(yield* exists(seen), "the ssh command didn't run")
      assert.notInclude(yield* read(seen), "HUNTAWAY_GH_GIT_TOKEN", "the token was in its environment")
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect("pushes send no configured Authorization header", () =>
    Effect.gen(function* () {
      // A server that records the Authorization headers git sends, and asks for a login.
      const seen: Array<string> = []
      const port = yield* Effect.acquireRelease(
        Effect.callback<{ readonly port: number; readonly close: () => void }>((resume) => {
          const server = createServer((conn) => {
            let request = ""
            conn.on("data", (b) => {
              request += b.toString("latin1")
              if (!request.includes("\r\n\r\n")) return
              seen.push(...request.split("\r\n").filter((l) => l.toLowerCase().startsWith("authorization:")))
              conn.end('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="x"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
            })
            conn.on("error", () => undefined)
          })
          server.listen(0, "127.0.0.1", () => {
            const address = server.address()
            resume(Effect.succeed({ port: typeof address === "object" && address !== null ? address.port : 0, close: () => server.close() }))
          })
        }),
        (s) => Effect.sync(s.close),
      ).pipe(Effect.map((s) => s.port))
      const dir = yield* tempDir
      const url = `http://127.0.0.1:${port}/o/r.git`
      const other = "Authorization: Basic b3RoZXI6b3RoZXItdG9rZW4=" // other:other-token
      yield* git(dir, ["init", "-q"])
      // Set for every URL, for the server, and for the repository's path.
      for (const key of ["http.extraHeader", `http.http://127.0.0.1:${port}/.extraHeader`, `http.${url}.extraHeader`]) yield* git(dir, ["config", key, other])
      const send = (resets: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          seen.length = 0
          yield* gitWith(dir, [...resets, "-c", "credential.helper=", "ls-remote", url], { ...PLAIN_GIT, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false" })
          return [...seen]
        })
      // The test sees configured headers...
      assert.isTrue((yield* send([])).some((h) => h.includes("b3RoZXI6")))
      // ...and the resets git_push and fetches get leave none.
      const configured = yield* gitWith(dir, ["config", "--get-regexp", "^http\\..*extraheader$"], PLAIN_GIT)
      const resets = dashC(extraHeaderResets(configured))
      const sent = yield* send(resets)
      assert.isTrue(
        sent.every((h) => !h.includes("b3RoZXI6")),
        `${sent.join(", ")} with ${resets.join(" ")}`,
      )
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect("fetches use only the selected account's HTTPS credentials", () =>
    withGitHub({ accounts: [{ host: "ghe.example.com", login: "chosen", token: "test-token" }] }, () =>
      Effect.gen(function* () {
        const access = yield* GitHubAccess
        const dir = yield* tempDir
        yield* git(dir, ["init", "-q"])
        yield* git(dir, ["remote", "add", "origin", "https://alias/o/r.git"])
        yield* git(dir, ["config", "url.https://ghe.example.com/.insteadOf", "https://alias/"])
        yield* git(dir, ["config", "credential.helper", "!f() { echo username=wrong; echo password=wrong; }; f"])
        yield* git(dir, ["config", "http.extraHeader", "Authorization: wrong"])
        // The fetch URL as git resolves the remote.
        const remoteUrl = yield* git(dir, ["remote", "get-url", "origin"])
        assert.strictEqual(remoteUrl, "https://ghe.example.com/o/r.git")
        const env = yield* access.fetchEnv(dir, "ghe.example.com/chosen", remoteUrl)
        assert.isTrue(Object.entries(env).some(([k, v]) => k.startsWith("GIT_CONFIG_KEY_") && v === "http.extraheader"))
        const fill = (e: Readonly<Record<string, string | undefined>>) =>
          gitWith(dir, ["credential", "fill"], { ...PLAIN_GIT, GIT_TERMINAL_PROMPT: "0", ...e }, "protocol=https\nhost=ghe.example.com\n\n")
        const credentials = yield* fill(env)
        assert.include(credentials, "username=x-access-token\npassword=test-token")
        // No account selected leaves git's own authentication alone.
        assert.deepStrictEqual(yield* access.fetchEnv(dir, null, remoteUrl), {})
        // A missing login is never the active account or the configured helper.
        const missing = yield* access.fetchEnv(dir, "ghe.example.com/missing", remoteUrl)
        assert.isFalse(Object.values(missing).includes("test-token"))
        assert.notInclude(yield* fill(missing), "password=wrong")
        // SSH, local remotes and unrelated HTTPS hosts don't need gh at all.
        for (const url of ["git@github-work:o/r.git", "/tmp/local.git", "https://elsewhere.example/o/r.git"]) {
          assert.deepStrictEqual(yield* access.fetchEnv(dir, "ghe.example.com/missing", url), {}, url)
        }
      }),
    ),
  )

  it.effect("pushes with the account's token over HTTPS, and the user's helper elsewhere", () =>
    Effect.gen(function* () {
      // What credentials git would use: only ours for the account's host, whatever helper the user has (here a global
      // one, as `gh auth setup-git` adds), and theirs elsewhere.
      const home = yield* tempDir
      const config = dashC(gitCredentialConfig(parseAccount("octocat") ?? assert.fail("no account")))
      const fill = (host: string) =>
        gitWith(
          home,
          ["-c", "credential.helper=!f() { echo username=theirs; echo password=other; }; f", ...config, "credential", "fill"],
          { HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: "1", HUNTAWAY_GH_GIT_TOKEN: "tok123" },
          `protocol=https\nhost=${host}\n\n`,
        )
      const ours = yield* fill("github.com")
      assert.isTrue(ours.includes("username=x-access-token\n") && ours.includes("password=tok123\n"), ours)
      assert.include(yield* fill("gitlab.com"), "password=other\n")
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect("reads a pull request as the account for the git area", () =>
    withGitHub({ accounts: [ME, OTHER], repos: { "o/r": { pulls: [fakePull({ number: 3, head: "feature", headOid: "abc123" })] } } }, (fake) =>
      Effect.gen(function* () {
        const access = yield* GitHubAccess
        const dir = yield* tempDir
        const view = yield* access.pullRequest(dir, "me", "3", "o/r")
        assert.deepStrictEqual(view, {
          state: "OPEN",
          headRefName: "feature",
          baseRefName: "main",
          headRefOid: "abc123",
          isCrossRepository: false,
          url: "https://github.com/o/r/pull/3",
        })
        assert.strictEqual((yield* fake.calls).at(-1)?.as, "me")
        assert.isNull(yield* access.pullRequest(dir, "me", "no-such-branch", "o/r"))
        const failed = yield* Effect.flip(access.pullRequest(dir, "me", "3", "x/y"))
        assert.strictEqual(failed._tag, "GitHubUnavailable")
        assert.include((yield* Effect.flip(access.pullRequest(dir, "nobody", "3", "o/r"))).reason, "isn't signed in")
      }),
    ),
  )
})
