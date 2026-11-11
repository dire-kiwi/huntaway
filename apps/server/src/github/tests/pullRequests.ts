import { Effect, FileSystem, Option } from "effect"
import type { Project, Task } from "@huntaway/contracts"
import { fakePull, git } from "@huntaway/testing"
import type { FakeGitHubState, FakePull } from "@huntaway/testing"
import { ProjectRepo } from "../../projects/ProjectRepo.ts"

// What the pull request tests share: a project whose repository is pushed to o/r on GitHub, and a fake GitHub with
// pull request 7 there (as the old pr_watch tests' `response`: open, mergeable, head a1), read as `me`.

/** The project's repository made a git repository whose `origin` is `url` (o/r on GitHub by default). */
export const onGitHub = (p: Project, url = "git@github.com:o/r.git") =>
  Effect.gen(function* () {
    const found = yield* (yield* ProjectRepo).get(p.id)
    const dir = Option.isSome(found) ? found.value.repo_path : yield* Effect.die("no project")
    yield* (yield* FileSystem.FileSystem).makeDirectory(dir, { recursive: true }).pipe(Effect.orDie)
    yield* git(dir, ["init", "-q", "-b", "main"])
    yield* git(dir, ["remote", "add", "origin", url])
    return dir
  })

/** The `origin` of task `t`'s project's repository set to `url`. */
export const setOrigin = (t: Task, url: string) =>
  Effect.gen(function* () {
    const found = t.project_id === null ? Option.none() : yield* (yield* ProjectRepo).get(t.project_id)
    const dir = Option.isSome(found) ? found.value.repo_path : yield* Effect.die("no project")
    yield* git(dir, ["remote", "set-url", "origin", url])
  })

/** Pull request 7 of o/r, open and mergeable, its head `a1`, with `fields`. */
export const pull7 = (fields: Partial<FakePull> = {}): FakePull => fakePull({ number: 7, head: "feature", headOid: "a1", title: "A change", ...fields })

/** A fake GitHub where `me` is gh's account, and o/r has `pulls` (and `jobs`' logs). */
export const github = (pulls: ReadonlyArray<FakePull>, jobs: Readonly<Record<string, string>> = {}): FakeGitHubState => ({
  accounts: [{ host: "github.com", login: "me", token: "tok-me", active: true }],
  repos: { "o/r": { pulls: [...pulls], jobs: { ...jobs } } },
})

/** A failed required check of the Tests workflow, job `id`. */
export const failedCheck = (name: string, id: number) => ({
  name,
  state: "FAILURE",
  bucket: "fail",
  workflow: "Tests",
  required: true,
  id,
  link: `https://github.com/o/r/actions/runs/1/job/${id}`,
})
