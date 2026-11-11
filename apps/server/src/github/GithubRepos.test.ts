import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Predicate } from "effect"
import type { FakeGitHub, FakeGitHubState } from "@huntaway/testing"
import { fakeGitHub, git, tempDir, TestBoard } from "@huntaway/testing"
import { Profiles } from "../profiles/Profiles.ts"
import { Projects } from "../projects/Projects.ts"
import { GithubRepos } from "./GithubRepos.ts"

// The old integrations/github.test.ts (cloning, creating, folders, clones by their remotes) and api/projects.test.ts'
// GitHub cases (`clones_a_github_repository_as_a_project`, `creates_a_github_repository_and_adds_the_folder_as_a_project`,
// `a_folder_being_cloned_into_waits_for_that_clone_and_isnt_added_twice`), over the fake GitHub of @huntaway/testing,
// whose repositories are cloned from folders here.

process.env["GIT_CONFIG_GLOBAL"] = "/dev/null"
process.env["GIT_CONFIG_NOSYSTEM"] = "1"

const ME = { host: "github.com", login: "me", token: "tok-me", active: true }

/** `body` on a board whose gh is the fake GitHub of `state` (`me` its account). */
const onBoard = <A, E, R>(state: FakeGitHubState, body: (fake: FakeGitHub) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fake = yield* fakeGitHub({ accounts: [ME], ...state })
    return yield* body(fake).pipe(Effect.provide(TestBoard({ ghBin: fake.bin })))
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

const fsDo = <A, E>(f: (fs: FileSystem.FileSystem) => Effect.Effect<A, E>) => Effect.flatMap(FileSystem.FileSystem, (fs) => f(fs).pipe(Effect.orDie))
const exists = (p: string) => fsDo((fs) => fs.exists(p))
const read = (p: string) => fsDo((fs) => fs.readFileString(p))
const write = (p: string, text: string) => fsDo((fs) => fs.writeFileString(p, text))
const mkdir = (p: string) => fsDo((fs) => fs.makeDirectory(p, { recursive: true }))
const entries = (p: string) => fsDo((fs) => fs.readDirectory(p))
/** What a failure says: a `Conflict`'s detail, an `Invalid`'s reason, or its message. */
const said = (e: { readonly message: string }): string =>
  Predicate.hasProperty(e, "detail") && typeof e.detail === "string"
    ? e.detail
    : Predicate.hasProperty(e, "reason") && typeof e.reason === "string"
      ? e.reason
      : e.message
const message = <A, E extends { readonly message: string }, R>(e: Effect.Effect<A, E, R>) => Effect.map(Effect.flip(e), said)

/** Folders with a commit each (a README saying its name) for the fake's repositories to be cloned from. */
const sources = (names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const dir = yield* tempDir
    const out: Record<string, string> = {}
    for (const name of names) {
      const work = `${dir}/${name}`
      yield* mkdir(work)
      yield* write(`${work}/README`, name)
      yield* git(work, ["init", "-q", "-b", "main"])
      yield* git(work, ["add", "-A"])
      yield* git(work, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"])
      out[name] = work
    }
    return out
  })

/** A repository at `dir` with one commit. */
const repoAt = (dir: string) =>
  Effect.gen(function* () {
    yield* mkdir(dir)
    yield* git(dir, ["init", "-q", "-b", "main"])
    yield* git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"])
  })

describe("GithubRepos", () => {
  // a_clone_that_fails_is_taken_away_but_gh_failing_after_a_whole_one_keeps_it
  it.live("takes a failed clone away, but keeps one gh failed after it was whole", () =>
    Effect.gen(function* () {
      const src = yield* sources(["r", "checkout-fails", "upstream-fails"])
      yield* onBoard(
        {
          repos: {
            "o/r": { source: src["r"] ?? "" },
            "o/checkout-fails": { source: src["checkout-fails"] ?? "", cloneBreaks: "checkout" },
            "o/upstream-fails": { source: src["upstream-fails"] ?? "", cloneBreaks: "after" },
            "o/missing": { cloneFails: "GraphQL: Could not resolve to a Repository with the name 'o/missing'. (repository)" },
          },
        },
        (fake) =>
          Effect.gen(function* () {
            const repos = yield* GithubRepos
            const dir = yield* tempDir
            const dest = (name: string) => `${dir}/clones/${name}`
            assert.isTrue(yield* repos.clone(null, "o/r", dest("r")))
            assert.strictEqual(yield* read(`${dest("r")}/README`), "r")
            assert.strictEqual(yield* git(dest("r"), ["remote", "get-url", "origin"]), "https://github.com/o/r.git")
            // A clone that's there already is taken as it is, without cloning.
            const before = (yield* fake.calls).length
            assert.isFalse(yield* repos.clone(null, "o/r", dest("r")))
            assert.strictEqual((yield* fake.calls).length, before)

            // Git keeps a clone whose checkout failed, which isn't whole: it goes, from a new folder or an empty one.
            assert.include(yield* message(repos.clone(null, "o/checkout-fails", dest("checkout"))), "checkout failed")
            assert.isFalse(yield* exists(dest("checkout")))
            yield* mkdir(dest("empty"))
            yield* Effect.flip(repos.clone(null, "o/checkout-fails", dest("empty")))
            assert.deepStrictEqual(yield* entries(dest("empty")), [], "the empty folder stays, empty")

            // gh failing once the clone is whole (a fork's parent it couldn't fetch) leaves it.
            assert.isTrue(yield* repos.clone(null, "o/upstream-fails", dest("upstream")))
            assert.strictEqual(yield* read(`${dest("upstream")}/README`), "upstream-fails")
            // And nothing's taken away when gh can't clone it at all; a folder with something in it is refused first.
            assert.include(yield* message(repos.clone(null, "o/missing", dest("missing"))), "Could not resolve")
            yield* write(`${dir}/taken`, "")
            yield* mkdir(dest("full"))
            yield* write(`${dest("full")}/notes.txt`, "mine")
            assert.include(yield* message(repos.clone(null, "o/r", dest("full"))), "already exists")
          }),
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  // finds_clones_of_a_repository_by_their_remotes, through `clone`'s check of what's there
  it.live("finds a clone of a repository by its remotes, at the top of the folder", () =>
    onBoard({ repos: { "o/r": { cloneFails: "no" }, "parent/r": { cloneFails: "no" }, "o/other": { cloneFails: "not cloned" } } }, () =>
      Effect.gen(function* () {
        const repos = yield* GithubRepos
        const r = `${yield* tempDir}/r`
        yield* repoAt(r)
        yield* mkdir(`${r}/sub`)
        yield* write(`${r}/sub/f`, "x")
        yield* git(r, ["remote", "add", "upstream", "git@github.com:parent/r.git"])
        yield* git(r, ["remote", "add", "origin", "https://github.com/O/R.git"])
        assert.isFalse(yield* repos.clone(null, "o/r", r))
        assert.isFalse(yield* repos.clone(null, "parent/r", r))
        assert.include(yield* message(repos.clone(null, "o/other", r)), "already exists")
        assert.include(yield* message(repos.clone("ghe.example.com/me", "o/r", r)), "already exists", "on another host")
        assert.include(yield* message(repos.clone(null, "o/r", `${r}/sub`)), "already exists", "a folder inside it")
      }),
    ),
  )

  // creates_a_repository_for_a_folder
  it.live("creates a repository for a folder, and leaves the folder as it was when it can't", () =>
    onBoard({}, (fake) =>
      Effect.gen(function* () {
        const repos = yield* GithubRepos
        const dir = yield* tempDir
        const created = (key: string) => Effect.map(fake.state, (s) => s.repos?.[key])
        const createCalls = Effect.map(fake.calls, (cs) => cs.filter((c) => c.args[0] === "repo" && c.args[1] === "create").map((c) => c.args.join(" ")))

        // A folder that isn't there: made a git repository, the repository private, no push (nothing to push).
        const fresh = `${dir}/projects/new`
        assert.deepStrictEqual(yield* repos.create(null, fresh, "o", "new", true), { full_name: "o/new", pushed: false, push_error: null })
        assert.isTrue(yield* exists(`${fresh}/.git`))
        const first = (yield* createCalls)[0] ?? ""
        assert.include(first, "repo create o/new --private --source")
        assert.notInclude(first, "--push")
        assert.strictEqual(yield* git(fresh, ["remote", "get-url", "origin"]), "https://github.com/o/new.git")
        assert.strictEqual((yield* created("o/new"))?.private, true)

        // A repository with commits is pushed, and a public one says so. Without an owner, gh's account owns it.
        const old = `${dir}/old`
        yield* repoAt(old)
        assert.deepStrictEqual(yield* repos.create(null, old, null, "old", false), { full_name: "me/old", pushed: true, push_error: null })
        assert.include((yield* createCalls)[1] ?? "", "repo create old --public --source")
        assert.include((yield* createCalls)[1] ?? "", "--push")
        assert.strictEqual((yield* created("me/old"))?.pushed, true)

        // A push that fails leaves the repository and the remote, and says so.
        yield* fake.update((s) => ({ ...s, pushFails: "remote: Permission denied" }))
        const pf = `${dir}/pf`
        yield* repoAt(pf)
        const made = yield* repos.create(null, pf, "o", "push-fails", true)
        assert.isFalse(made.pushed)
        assert.include(made.push_error ?? "", "Permission denied")
        assert.strictEqual(made.full_name, "o/push-fails")
        yield* fake.update((s) => ({ ...s, pushFails: undefined }))

        // A repository gh can't create leaves the folder as it was: a new folder is taken away, and a folder that wasn't a
        // repository isn't one.
        yield* fake.update((s) => ({ ...s, createFails: "GraphQL: Name already exists on this account (createRepository)" }))
        const gone = `${dir}/gone/fails`
        assert.include(yield* message(repos.create(null, gone, "o", "fails", true)), "Name already exists")
        assert.isFalse(yield* exists(`${dir}/gone`))
        const plain = `${dir}/plain`
        yield* mkdir(plain)
        yield* write(`${plain}/f`, "x")
        yield* Effect.flip(repos.create(null, plain, "o", "fails", true))
        assert.isFalse(yield* exists(`${plain}/.git`))
        assert.isTrue(yield* exists(`${plain}/f`))

        // A failure takes away only what this call made. A path through a folder that isn't there and back out
        // (`missing/../valuable`) names the folder that is, with what's in it.
        const valuable = `${dir}/valuable`
        yield* mkdir(valuable)
        yield* write(`${valuable}/mine.txt`, "keep")
        assert.include(yield* message(repos.create(null, `${dir}/missing/../valuable`, "o", "fails", true)), "Name already exists")
        assert.strictEqual(yield* read(`${valuable}/mine.txt`), "keep")
        assert.isFalse(yield* exists(`${valuable}/.git`))
        assert.isFalse(yield* exists(`${dir}/missing`))
        // Nor are the folders above a new one that were there.
        assert.include(yield* message(repos.create(null, `${valuable}/a/b`, "o", "fails", true)), "Name already exists")
        assert.isFalse(yield* exists(`${valuable}/a`))
        assert.isTrue(yield* exists(`${valuable}/mine.txt`))

        // Git metadata git won't open (a repository without its HEAD, as another owner's or a damaged one) is neither
        // initialised over nor taken away, whether or not gh would have created the repository.
        const broken = `${dir}/broken`
        yield* repoAt(broken)
        yield* fsDo((fs) => fs.rename(`${broken}/.git/HEAD`, `${broken}/.git/HEAD.saved`))
        const calls = (yield* createCalls).length
        for (const fails of [true, false]) {
          yield* fake.update((s) => ({ ...s, createFails: fails ? "GraphQL: Name already exists" : undefined }))
          assert.include(yield* message(repos.create(null, broken, "o", "x", true)), "has a .git that git can't use")
          assert.isTrue(yield* exists(`${broken}/.git/HEAD.saved`))
          assert.isFalse(yield* exists(`${broken}/.git/HEAD`))
        }
        assert.strictEqual((yield* createCalls).length, calls)

        // A folder that isn't there inside a repository isn't left behind when it's turned down.
        assert.include(yield* message(repos.create(null, `${old}/not/yet`, null, "yet", true)), "is inside the repository")
        assert.isFalse(yield* exists(`${old}/not`))
        // Refused before gh runs: an origin already there, a folder inside a repository, a bad owner.
        assert.include(yield* message(repos.create(null, old, null, "again", true)), "already has a remote called origin")
        yield* mkdir(`${old}/sub`)
        assert.include(yield* message(repos.create(null, `${old}/sub`, null, "sub", true)), "is inside the repository")
        yield* Effect.flip(repos.create(null, `${dir}/bad`, "-o", "bad", true))
        assert.isFalse(yield* exists(`${dir}/bad`))
        assert.strictEqual((yield* createCalls).length, calls)
      }),
    ),
  )

  it.live("can't run a gh that isn't there", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir
      yield* Effect.gen(function* () {
        const repos = yield* GithubRepos
        assert.include(yield* message(repos.create(null, `${dir}/no-gh`, null, "x", true)), "gh")
        assert.isFalse(yield* exists(`${dir}/no-gh`))
        yield* Effect.flip(repos.clone(null, "o/r", `${dir}/no-gh-clone`))
        assert.isFalse(yield* exists(`${dir}/no-gh-clone`))
        const list = yield* repos.list(null, null)
        assert.deepStrictEqual([list.repos, list.error === null], [[], false])
        assert.isNotNull((yield* repos.accounts).error)
      }).pipe(Effect.provide(TestBoard({ ghBin: "/nonexistent/gh" })))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  // names_a_folder_the_same_before_and_after_it_is_made: through a clone's reservation (two requests for one folder
  // however it's written are one project), below.

  // a_folder_being_cloned_into_waits_for_that_clone_and_isnt_added_twice
  it.live("clones a repository into the profile's clone folder once, however its folder is written", () =>
    Effect.gen(function* () {
      const src = yield* sources(["r", "slow"])
      yield* onBoard({ repos: { "o/r": { source: src["r"] ?? "" }, "o/slow": { source: src["slow"] ?? "" } } }, () =>
        Effect.gen(function* () {
          const repos = yield* GithubRepos
          const dir = yield* tempDir
          const profile = yield* (yield* Profiles).create({ name: "p", clone_dir: `${dir}/clones` })
          // By default into the profile's clone folder, named after the repository.
          const p = yield* repos.cloneProject({ profile_id: profile.id, repo: "o/r", key: "rr" })
          assert.deepStrictEqual([p.name, p.key, p.repo_path], ["r", "RR", `${dir}/clones/r`])
          assert.strictEqual(yield* read(`${dir}/clones/r/README`), "r")
          // A second time it's the project already.
          const again = yield* Effect.flip(repos.cloneProject({ profile_id: profile.id, repo: "o/r" }))
          assert.strictEqual(again._tag, "Conflict")
          assert.include(said(again), 'already the project "r"')
          // Its key is checked before cloning anything.
          assert.include(
            yield* message(repos.cloneProject({ profile_id: profile.id, repo: "o/other", repo_path: `${dir}/other`, key: "RR" })),
            "already has the key RR",
          )
          assert.include(yield* message(repos.cloneProject({ profile_id: profile.id, repo: "o/other", repo_path: `${dir}/other`, key: "S" })), "scratch")
          assert.include(yield* message(repos.cloneProject({ profile_id: profile.id, repo: "nope" })), "OWNER/REPO")
          assert.isFalse(yield* exists(`${dir}/other`))

          // Two requests for one folder, however it's written (a symlink to a folder above it, a folder that isn't there
          // and `..`), are one clone and one project: the second waits for the first and finds its project.
          yield* mkdir(`${dir}/real`)
          yield* fsDo((fs) => fs.symlink(`${dir}/real`, `${dir}/alias`))
          for (const [given, folder] of [
            ["alias/new/slow", "real/new/slow"],
            ["missing/../alias/other/slow", "real/other/slow"],
          ] as const) {
            const clone = repos.cloneProject({ profile_id: profile.id, repo: "o/slow", repo_path: `${dir}/${given}` })
            const [a, b] = yield* Effect.all([Effect.result(clone), Effect.result(clone)], { concurrency: 2 })
            const ok = [a, b].filter((x) => x._tag === "Success")
            const refused = [a, b].flatMap((x) => (x._tag === "Failure" ? [x.failure] : []))
            assert.strictEqual(ok.length, 1, given)
            assert.strictEqual(refused[0]?._tag, "Conflict", given)
            assert.include(refused[0] === undefined ? "" : said(refused[0]), 'already the project "slow"')
            const projects = (yield* (yield* Projects).list(profile.id, false)).filter((x) => x.repo_path === `${dir}/${folder}`)
            assert.strictEqual(projects.length, 1, given)
          }
        }),
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  // creates_a_github_repository_and_adds_the_folder_as_a_project
  it.live("creates a GitHub repository and adds the folder as a project", () =>
    onBoard({}, (fake) =>
      Effect.gen(function* () {
        const repos = yield* GithubRepos
        const dir = yield* tempDir
        const profile = yield* (yield* Profiles).create({ name: "p" })
        const path = (n: string) => `${dir}/projects/${n}`
        const create = (b: { readonly repo_path: string; readonly [k: string]: unknown }) =>
          repos.createProject({ profile_id: profile.id, visibility: "private", ...b })
        const calls = Effect.map(fake.calls, (cs) => cs.filter((c) => c.args[1] === "create").map((c) => c.args.join(" ")))

        let made = yield* create({ repo_path: path("one"), owner: "o", key: "ab" })
        assert.deepStrictEqual([made.project.name, made.project.key, made.github.full_name], ["one", "AB", "o/one"])
        assert.include((yield* calls).join("\n"), "repo create o/one --private")
        assert.isTrue(yield* exists(`${path("one")}/.git`))
        // The repository can be named differently from the folder, and be public.
        made = yield* create({ repo_path: path("two"), repo_name: "other", owner: "o", visibility: "public", name: "Two" })
        assert.deepStrictEqual([made.project.name, made.github.full_name], ["Two", "o/other"])
        assert.include((yield* calls).join("\n"), "repo create o/other --public")

        // Checked before anything is made: the name, the path, the key, and a project there already.
        const before = (yield* calls).length
        assert.include(yield* message(create({ repo_path: path("x"), repo_name: "a b" })), "repository's name")
        assert.include(yield* message(create({ repo_path: "x" })), "absolute")
        assert.include(yield* message(create({ repo_path: path("x"), key: "AB" })), "already has the key AB")
        assert.include(yield* message(create({ repo_path: path("one") })), 'already the project "one"')
        assert.strictEqual((yield* calls).length, before)
        assert.isFalse(yield* exists(path("x")))
        // A repository GitHub refuses adds no project and leaves nothing behind.
        yield* fake.update((s) => ({ ...s, createFails: "GraphQL: Name already exists on this account (createRepository)" }))
        assert.include(yield* message(create({ repo_path: path("fails") })), "Name already exists")
        assert.isFalse(yield* exists(path("fails")))
        assert.strictEqual((yield* (yield* Projects).list(profile.id, false)).length, 2)
      }),
    ),
  )

  it.live("lists the repositories an account can clone, and finds others by name", () =>
    onBoard(
      {
        orgs: { me: ["acme"] },
        repos: {
          "me/old": { pushed_at: "2024-01-01T00:00:00Z" },
          "me/website": { pushed_at: "2026-10-01T00:00:00Z", description: "The site", private: true },
          "friend/shared": { pushed_at: "2025-06-01T00:00:00Z", collaborators: ["me"] },
          "acme/tool": { pushed_at: "2026-11-01T00:00:00Z", contributors: ["me"] },
          "acme/website-old": { pushed_at: "2020-01-01T00:00:00Z" },
          "stranger/website": { pushed_at: "2026-11-02T00:00:00Z" },
        },
      },
      () =>
        Effect.gen(function* () {
          const repos = yield* GithubRepos
          const all = yield* repos.list(null, null)
          assert.strictEqual(all.error, null)
          assert.strictEqual(all.account, "me")
          assert.deepStrictEqual(
            all.repos.map((r) => r.full_name),
            ["acme/tool", "me/website", "friend/shared", "me/old"],
          )
          assert.deepStrictEqual([all.repos[1]?.description, all.repos[1]?.private], ["The site", true])
          // A search is among the account's and its organizations', by name.
          const found = yield* repos.list(null, " website ")
          assert.deepStrictEqual(found.repos.map((r) => r.full_name).toSorted(), ["acme/website-old", "me/website"])
          assert.deepStrictEqual(
            (yield* repos.list(null, "stranger/web")).repos.map((r) => r.full_name),
            ["stranger/website"],
          )
          assert.deepStrictEqual((yield* repos.list(null, "::")).repos, [])
          // As another account: one gh isn't signed in to says so.
          const other = yield* repos.list("someone", null)
          assert.deepStrictEqual([other.account, other.repos], ["someone", []])
          assert.include(other.error ?? "", "someone")
          // The accounts gh is signed in to.
          assert.deepStrictEqual(yield* repos.accounts, {
            accounts: [{ account: "me", host: "github.com", login: "me", active: true, ok: true }],
            error: null,
          })
        }),
    ),
  )
})
