// The old tests/repoSource.test.ts, every case.
import assert from "node:assert/strict"
import type { GithubRepo } from "@huntaway/contracts"
import { afterEach, test } from "vite-plus/test"
import {
  clonePath,
  defaultCloneDir,
  filterRepos,
  loadProjectSource,
  mergeRepos,
  repoFromInput,
  saveProjectSource,
} from "../../src/components/settings/repoSource"

const repo = (full_name: string): GithubRepo => ({
  full_name,
  name: full_name.split("/")[1] ?? "",
  description: null,
  private: false,
  fork: false,
  archived: false,
  pushed_at: null,
  url: null,
})
const names = (repos: ReadonlyArray<GithubRepo>) => repos.map((r) => r.full_name)
// The storage the tests put in place of the browser's: only what the module calls.
const globals = globalThis as { localStorage?: Pick<Storage, "getItem" | "setItem"> }
afterEach(() => {
  delete globals.localStorage
})

test("a profile clones into a folder named after it unless it picks one, as the server has it", () => {
  assert.equal(defaultCloneDir("personal"), "~/personal")
  assert.equal(defaultCloneDir(" a/b "), "~/a-b")
  for (const name of ["", " ", ".", ".."]) assert.equal(defaultCloneDir(name), "~")
  assert.equal(clonePath("~/personal", "dkcode"), "~/personal/dkcode")
  assert.equal(clonePath("/srv/repos/ ", "x"), "/srv/repos/x")
  assert.equal(clonePath("~", "x"), "~/x")
  assert.equal(clonePath("/", "x"), "/x")
})

test("reads OWNER/REPO from what's typed or a pasted github.com URL", () => {
  for (const [input, want] of [
    ["dire-kiwi/dkcode", "dire-kiwi/dkcode"],
    [" o/r.git ", "o/r"],
    ["octo-org/.github", "octo-org/.github"],
    ["https://github.com/o/r", "o/r"],
    ["https://www.github.com/o/r/tree/main/src?x=1", "o/r"],
    ["https://github.com/o/r.git", "o/r"],
    ["git@github.com:o/r.git", "o/r"],
    ["ssh://git@ssh.github.com:443/o/r.git", "o/r"],
  ] as const) {
    assert.equal(repoFromInput(input), want, input)
  }
  for (const input of ["", "dkcode", "o/", "/r", "o/r/x", "-o/r", "o/..", "o/r x", "https://gitlab.com/o/r", "https://github.com/o"]) {
    assert.equal(repoFromInput(input), null, input)
  }
})

test("filters repositories by every word typed, owner included, keeping their order", () => {
  const repos = [repo("jenkinsci/gitlab-plugin"), repo("imeredith/gitlab-notes"), repo("dire-kiwi/dkcode")]
  assert.deepEqual(names(filterRepos(repos, "")), names(repos))
  assert.deepEqual(names(filterRepos(repos, "GitLab")), ["jenkinsci/gitlab-plugin", "imeredith/gitlab-notes"])
  assert.deepEqual(names(filterRepos(repos, "jenkinsci/gitlab")), ["jenkinsci/gitlab-plugin"])
  assert.deepEqual(names(filterRepos(repos, "kiwi code")), ["dire-kiwi/dkcode"])
})

test("adds what a search found after the listed repositories, without repeating them", () => {
  const merged = mergeRepos([repo("me/a"), repo("me/b")], [repo("ME/A"), repo("org/c")])
  assert.deepEqual(names(merged), ["me/a", "me/b", "org/c"])
})

test("remembers where the last project was added from", () => {
  const store = new Map<string, string>()
  globals.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }
  assert.equal(loadProjectSource(), "folder")
  saveProjectSource("github")
  assert.equal(loadProjectSource(), "github")
  saveProjectSource("folder")
  assert.equal(loadProjectSource(), "folder")
  globals.localStorage = {
    getItem: () => {
      throw new Error("no storage")
    },
    setItem: () => {
      throw new Error("no storage")
    },
  }
  assert.equal(loadProjectSource(), "folder")
  saveProjectSource("github")
})
