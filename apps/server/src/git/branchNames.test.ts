import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import type { FileSystem, Scope } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import type { SqlClient } from "effect/sql"
import { git, gitRepo, tempDir, TestBoard } from "@huntaway/testing"
import type { NewTask, Project, Task } from "@huntaway/contracts"
import { Actor } from "../platform/Changes.ts"
import { Profiles } from "../profiles/Profiles.ts"
import { Projects } from "../projects/Projects.ts"
import { PenRepo } from "../tasks/PenRepo.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { branchNamesOf } from "./branchNames.ts"
import { Worktrees } from "./Worktrees.ts"

// A set of tasks across repositories on real repositories (HE-117): its one branch name kept clear of every
// repository's local and remote branches, its tasks made all together or not at all, and its worktrees set up on it.
// Which name is free is tasks/sets.test.ts's table.

process.env["GIT_CONFIG_GLOBAL"] = "/dev/null"
process.env["GIT_CONFIG_NOSYSTEM"] = "1"

type Env = Tasks | Projects | Profiles | Worktrees | PenRepo | SqlClient.SqlClient
const run = <A, E>(effect: Effect.Effect<A, E, Env | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(TestBoard()))

/** A profile with a project on a fresh repository (on `main`) for each of API, WEB and DOC. */
const board = Effect.gen(function* () {
  const profile = yield* (yield* Profiles).create({ name: "me" })
  const one = (key: string) =>
    Effect.gen(function* () {
      const repo = yield* gitRepo
      return { project: yield* (yield* Projects).create({ profile_id: profile.id, name: key.toLowerCase(), key, repo_path: repo, base_branch: "main" }), repo }
    })
  return { a: yield* one("API"), b: yield* one("WEB"), c: yield* one("DOC") }
}).pipe(Effect.orDie)

const create = (input: NewTask) => Effect.flatMap(Tasks, (tasks) => tasks.create(input, Actor.user))
const projectTasks = (project: Project) => Effect.flatMap(Tasks, (tasks) => tasks.list({ _tag: "ByProject", project_id: project.id })).pipe(Effect.orDie)
/** The one task of a project. */
const only = (project: Project) =>
  Effect.flatMap(projectTasks(project), (list) => (list.length === 1 && list[0] !== undefined ? Effect.succeed(list[0]) : Effect.die(`${list.length} tasks`)))
const view = (t: Task) => [t.key, t.title, t.description, t.status, t.branch, t.lead_id ?? null, t.use_worktree]
const reason = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.flip(effect), (e) =>
    "detail" in e && typeof e.detail === "string" ? e.detail : "reason" in e && typeof e.reason === "string" ? e.reason : e._tag,
  )

describe("a repository's branch names", () => {
  it("are its local and remote branches, without the remote (the longest that fits) and its HEAD", () => {
    const refs = [
      "refs/heads/main",
      "refs/heads/ia/he-1-x",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
      "refs/remotes/origin/ia/he-2-y/z",
      "refs/remotes/my/fork/feature",
      "refs/remotes/gone/old",
      "refs/tags/v1",
    ]
    assert.deepStrictEqual(branchNamesOf(refs, ["origin", "my", "my/fork"]), ["main", "ia/he-1-x", "ia/he-2-y/z", "feature", "old"])
    assert.deepStrictEqual(branchNamesOf([], []), [])
  })
})

describe("a set of tasks across repositories", () => {
  it.live("is one task per repository on one branch name free in all of them, in one pen, and their worktrees are set up on it", () =>
    run(
      Effect.gen(function* () {
        const { a, b, c } = yield* board
        const base = "ia/api-1-api-and-client"
        // Taken: locally in A, as a remote's folder in B (`a` beside `a/b`), and locally in C.
        yield* git(a.repo, ["branch", base])
        yield* git(b.repo, ["remote", "add", "origin", `${a.repo}-nowhere`])
        yield* git(b.repo, ["update-ref", `refs/remotes/origin/${base}-2/x`, "HEAD"])
        yield* git(c.repo, ["branch", `${base}-3`])

        const lead = yield* create({
          project_id: a.project.id,
          title: "API and client",
          description: "Both ends",
          also_in: ["web", c.project.id],
          start: false,
        })
        const [l, x, y] = [yield* only(a.project), yield* only(b.project), yield* only(c.project)]
        assert.deepStrictEqual([lead, l, x, y].map(view), [
          ["API-1", "API and client", "Both ends", "todo", `${base}-4`, null, true],
          ["API-1", "API and client", "Both ends", "todo", `${base}-4`, null, true],
          ["WEB-1", "API and client", "Both ends", "todo", `${base}-4`, lead.id, true],
          ["DOC-1", "API and client", "Both ends", "todo", `${base}-4`, lead.id, true],
        ])
        // One pen, named after the title, made with it.
        const pen = lead.pen_id === null ? null : yield* (yield* PenRepo).get(lead.pen_id)
        assert.strictEqual(pen?.name, "API and client")
        assert.deepStrictEqual([x.pen_id, y.pen_id], [lead.pen_id, lead.pen_id])

        // Each worktree is its own repository's, on the set's branch, from its own base.
        const worktrees = yield* Worktrees
        for (const [t, repo] of [
          [lead, a.repo],
          [x, b.repo],
        ] as const) {
          const set = yield* worktrees.setup(t.id)
          assert.strictEqual(set.branch, `${base}-4`)
          assert.strictEqual(yield* git(set.worktree_path ?? "", ["rev-parse", "--abbrev-ref", "HEAD"]), `${base}-4`)
          assert.strictEqual(yield* git(repo, ["rev-parse", `${base}-4`]), yield* git(repo, ["rev-parse", "main"]))
        }

        // A set made later in the same projects is given a name of its own, and the pen it's given.
        const second = yield* create({ project_id: a.project.id, title: "API and client", also_in: ["WEB"], pen: "Shared" })
        assert.strictEqual(second.branch, "ia/api-2-api-and-client")
        const shared = second.pen_id === null ? null : yield* (yield* PenRepo).get(second.pen_id)
        assert.strictEqual(shared?.name, "Shared")
      }),
    ),
  )

  it.live("is made all together or not at all", () =>
    run(
      Effect.gen(function* () {
        const { a, b, c } = yield* board
        // A branch called `ia` in C leaves no `ia/…` name free there: refused once the lead is in, which is undone.
        yield* git(c.repo, ["branch", "ia"])
        assert.strictEqual(
          yield* reason(create({ project_id: a.project.id, title: "API and client", also_in: ["WEB", "DOC"] })),
          "ia/api-1-api-and-client and its -2 to -50 are all taken in the set's repositories",
        )
        assert.deepStrictEqual([...(yield* projectTasks(a.project)), ...(yield* projectTasks(b.project))], [])
        assert.isNull(yield* (yield* PenRepo).byName(a.project.profile_id, "API and client"))
        // Its number wasn't used up.
        assert.strictEqual((yield* create({ project_id: a.project.id, title: "One" })).key, "API-1")

        // A folder that isn't a repository is refused before anything is made.
        const plain = yield* tempDir
        const d = yield* (yield* Projects).create({ profile_id: a.project.profile_id, name: "plain", key: "PLAIN", repo_path: plain }).pipe(Effect.orDie)
        const refused = yield* reason(create({ project_id: a.project.id, title: "Two", also_in: ["WEB", d.id] }))
        assert.match(refused, /plain doesn't use worktrees|can't read the branches of plain/)
        assert.deepStrictEqual((yield* projectTasks(b.project)).length, 0)

        // The projects it names are the profile's others, each once.
        assert.strictEqual(yield* reason(create({ project_id: a.project.id, title: "Two", also_in: ["Z"] })), 'no project "Z" on this board')
        assert.strictEqual(
          yield* reason(create({ project_id: a.project.id, title: "Two", also_in: ["API"] })),
          "api is the set's own project: name only the others",
        )
        assert.strictEqual(yield* reason(create({ project_id: a.project.id, title: "Two", also_in: ["WEB", "web"] })), "web is named twice")
        assert.strictEqual((yield* projectTasks(b.project)).length, 0)
      }),
    ),
  )
})
