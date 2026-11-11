import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer } from "effect"
import { git, tempDir, TestPlatform } from "@huntaway/testing"
import { Git } from "../git/Git.ts"
import { GithubRemote, isGithubCom, remoteRepo } from "./GithubRemote.ts"

// huntaway's git/worktree/tests.test.ts, its remote cases: `reads_github_remotes`, `finds_the_github_remote_pull_requests_go_to`
// and `an_ssh_host_alias_is_the_host_it_stands_for`. The pull request's lookup in the same test (`pr_view_args`) is plan
// task 4.5's (`PullRequests`, finding a task's pull request).

const RemoteLive = (sshConfig = "/dev/null") =>
  GithubRemote.layer.pipe(Layer.provideMerge(Git.layer), Layer.provideMerge(TestPlatform({ sshConfig })), Layer.provideMerge(NodeServices.layer))

/** `OWNER/REPO` from a remote URL on github.com. */
const githubRepo = (url: string) => {
  const r = remoteRepo(url)
  return r !== null && isGithubCom(r[0]) ? r[1] : null
}

/** A repository with no commits on master, in a temp folder. */
const repoOn = Effect.gen(function* () {
  const dir = yield* tempDir
  yield* git(dir, ["init", "-q", "-b", "master"])
  return dir
})

describe("GithubRemote", () => {
  it("reads GitHub remotes", () => {
    for (const url of [
      "git@github.com:o/r.git",
      "github.com:o/r",
      "https://github.com/o/r",
      "https://github.com/o/r.git/",
      "https://x:token@github.com/o/r.git",
      "ssh://git@ssh.github.com:443/o/r.git",
      "git://GitHub.com/o/r",
    ]) {
      assert.strictEqual(githubRepo(url), "o/r", url)
    }
    for (const url of [
      "git@gitlab.com:o/r.git",
      "https://example.com/github.com/o/r",
      "/srv/git/o/r.git",
      "./github.com:o/r",
      "https://github.com/o",
      "https://github.com/o/r/pull/1",
    ]) {
      assert.isNull(githubRepo(url), url)
    }
  })

  it.effect("finds the GitHub remote pull requests go to", () =>
    Effect.gen(function* () {
      const remote = yield* GithubRemote
      const repo = yield* repoOn
      assert.isNull(yield* remote.github(repo, "master"))
      yield* git(repo, ["remote", "add", "history", "git@github.com:o/history.git"])
      assert.deepStrictEqual(yield* remote.github(repo, "master"), { remote: "history", repo: "o/history" })
      yield* git(repo, ["remote", "add", "origin", "https://github.com/o/r.git"])
      const origin = { remote: "origin", repo: "o/r" }
      assert.deepStrictEqual(yield* remote.github(repo, "master"), origin)
      assert.deepStrictEqual(yield* remote.github(repo, null), origin)
      // The base branch's upstream comes first.
      yield* git(repo, ["config", "branch.master.remote", "history"])
      assert.strictEqual((yield* remote.github(repo, "master"))?.remote, "history")
      yield* git(repo, ["remote", "set-url", "history", "git@gitlab.com:o/history.git"])
      assert.isNull(yield* remote.github(repo, "master"))
      // It's where the branch is pushed that counts, not where it's fetched from.
      yield* git(repo, ["remote", "set-url", "--push", "history", "git@github.com:o/mirror.git"])
      assert.strictEqual((yield* remote.github(repo, "master"))?.repo, "o/mirror")
      yield* git(repo, ["remote", "set-url", "--push", "origin", "git@gitlab.com:o/r.git"])
      assert.isNull(yield* remote.github(repo, null))
    }).pipe(Effect.provide(RemoteLive())),
  )

  it.effect("an SSH host alias is the host it stands for", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* tempDir
      const config = `${dir}/ssh_config`
      yield* fs
        .writeFileString(config, "Host github-work\n  HostName github.com\n  IdentityFile ~/.ssh/work\nHost ghe\n  HostName GHE.acme.com\n")
        .pipe(Effect.orDie)
      const repo = yield* repoOn
      const checked = Effect.gen(function* () {
        const remote = yield* GithubRemote
        yield* git(repo, ["remote", "add", "origin", "git@github-work:o/r.git"])
        assert.deepStrictEqual(yield* remote.pushRepo(repo, null), ["github.com", "o/r"])
        assert.strictEqual((yield* remote.github(repo, null))?.repo, "o/r")
        yield* git(repo, ["remote", "set-url", "origin", "ssh://git@ghe/o/r.git"])
        assert.deepStrictEqual(yield* remote.pushRepo(repo, null), ["ghe.acme.com", "o/r"])
        assert.isNull(yield* remote.github(repo, null))
        // Only SSH remotes' hosts are aliases.
        yield* git(repo, ["remote", "set-url", "origin", "https://github-work/o/r.git"])
        assert.deepStrictEqual(yield* remote.pushRepo(repo, null), ["github-work", "o/r"])
        // A host the config doesn't name is as it is.
        yield* git(repo, ["remote", "set-url", "origin", "git@gitlab.com:o/r.git"])
        assert.deepStrictEqual(yield* remote.pushRepo(repo, null), ["gitlab.com", "o/r"])
      })
      yield* checked.pipe(Effect.provide(RemoteLive(config)))
    }).pipe(Effect.provide(NodeServices.layer)),
  )
})
