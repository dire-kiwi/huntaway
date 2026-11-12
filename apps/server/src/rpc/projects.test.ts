import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer } from "effect"
import { Headers } from "effect/http"
import { RpcMiddleware, RpcTest } from "effect/rpc"
import { Auth, HostRpcGroup, ProjectId, ProjectRpcs } from "@huntaway/contracts"
import { gitRepo, TestBoard } from "@huntaway/testing"
import { Profiles } from "../profiles/Profiles.ts"
import { Projects } from "../projects/Projects.ts"
import { AuthLive } from "./AuthLive.ts"
import { HostHandlers } from "./host.ts"
import { ProjectHandlers } from "./projects.ts"

// The project settings' Prompts tab (6.12) through the RPC server in process: the default instructions a project
// without its own uses (`host.defaultPrompts`) and the preview of what a new thread is told (`projects.systemPrompt`,
// whose text is `Prompts.preview`'s, tested there).

/** The board token on every request, as a client of the board sends it. */
const BoardToken = RpcMiddleware.layerClient(Auth, ({ next, request }) =>
  next({ ...request, headers: Headers.set(request.headers, "authorization", "Bearer test-token") }),
)

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(HostHandlers, ProjectHandlers, AuthLive, BoardToken).pipe(Layer.provideMerge(TestBoard()))))

describe("the Prompts tab's RPCs", () => {
  it.effect("host.defaultPrompts gives the start, review and merge instructions", () =>
    run(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(HostRpcGroup)
        const defaults = yield* client["host.defaultPrompts"]()
        assert.strictEqual(defaults.start_prompt, "Start working on this task.")
        assert.isTrue(defaults.review_prompt.startsWith("Look for correctness problems"), defaults.review_prompt)
        assert.isTrue(defaults.merge_prompt.startsWith("Commit any outstanding work"), defaults.merge_prompt)
      }),
    ),
  )

  it.effect("projects.get looks at the folder again, as the setup page asks while it isn't ready", () =>
    run(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(ProjectRpcs)
        const me = yield* (yield* Profiles).create({ name: "me" })
        const repo = yield* gitRepo
        const project = yield* (yield* Projects).create({ profile_id: me.id, name: "Web", key: "WEB", repo_path: repo })
        assert.deepStrictEqual([project.is_git, project.has_commits], [true, true])
        // Its repository goes (the folder stays): the next read says so.
        yield* (yield* FileSystem.FileSystem).remove(`${repo}/.git`, { recursive: true })
        const read = yield* client["projects.get"]({ id: project.id })
        assert.deepStrictEqual([read.is_git, read.has_commits], [false, false])
      }),
    ),
  )

  it.effect("projects.systemPrompt previews a new thread with the options given, and says so of a project that is gone", () =>
    run(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(ProjectRpcs)
        const me = yield* (yield* Profiles).create({ name: "me" })
        const project = yield* (yield* Projects).create({ profile_id: me.id, name: "Web", key: "WEB", repo_path: yield* gitRepo })
        const preview = yield* client["projects.systemPrompt"]({ id: project.id, options: {} })
        assert.deepStrictEqual([preview.runtime, preview.permission_mode], ["claude", "default"])
        assert.isTrue(preview.text.startsWith('You are an agent working on task WEB-1 ("Task title")'), preview.text)
        const codex = yield* client["projects.systemPrompt"]({ id: project.id, options: { runtime: "codex", permission_mode: "plan", worktree: false } })
        assert.deepStrictEqual([codex.runtime, codex.permission_mode], ["codex", "plan"])
        assert.isTrue(codex.text.includes("You are in plan mode") && !codex.text.includes("worktree at"), codex.text)
        const gone = yield* client["projects.systemPrompt"]({ id: ProjectId.make("gone"), options: {} }).pipe(Effect.flip)
        assert.deepStrictEqual(gone._tag === "NotFound" ? [gone.what, gone.id] : gone._tag, ["project", "gone"])
      }),
    ),
  )
})
