import { Effect } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { tempDir } from "./TestBoard.ts"

/** Git as "t", with nothing from the user's own configuration. */
const env = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
}

/** Runs git in `dir` and returns what it printed, trimmed. Fails on a non-zero exit. */
export const git = (dir: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return (yield* spawner.string(ChildProcess.make("git", ["-C", dir, ...args], { env, extendEnv: true }))).trim()
  }).pipe(Effect.orDie)

/** A fresh repository in a temp folder with one empty commit on `main`. */
export const gitRepo = Effect.gen(function* () {
  const dir = yield* tempDir
  yield* git(dir, ["init", "-q", "-b", "main"])
  yield* git(dir, ["commit", "-q", "--allow-empty", "-m", "init"])
  return dir
})
