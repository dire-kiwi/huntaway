import { assert, describe, it } from "@effect/vitest"
import { accountsFromStatus, checkName, checkRepo, ghError, graphqlRepo, latestFirst, restRepo, searchQuery } from "./model.ts"

// The pure cases of the old integrations/github.test.ts (and mcp/gh_mcp/env.ts' `accounts_from_status`).

/** A repository named `name`, last pushed at `pushed`. */
const pushedAt = (name: string, pushed: string | null) => ({
  full_name: name,
  name,
  description: null,
  private: false,
  fork: false,
  archived: false,
  pushed_at: pushed,
  url: null,
})

describe("adding a project from GitHub", () => {
  // repository_names_are_letters_digits_and_a_few_marks
  it("takes repository names of letters, digits and a few marks", () => {
    assert.strictEqual(checkName(" my-repo_1.x "), "my-repo_1.x")
    for (const bad of ["", ".", "..", "a b", "a/b", "é", "a".repeat(101)]) assert.strictEqual(checkName(bad), null, bad)
  })

  // repositories_are_owner_and_name
  it("takes repositories as OWNER/REPO", () => {
    assert.strictEqual(checkRepo(" dire-kiwi/dkcode "), "dire-kiwi/dkcode")
    assert.strictEqual(checkRepo("o/r.git"), "o/r")
    assert.strictEqual(checkRepo("octo-org/.github"), "octo-org/.github")
    assert.strictEqual(checkRepo("me/my_repo.v2"), "me/my_repo.v2")
    for (const bad of ["", "dkcode", "o/", "/r", "o/r/x", "-o/r", ".o/r", "o/..", "o/.", "o/r x", "o/r;rm", "https://github.com/o/r", "github.com/o/r"]) {
      assert.strictEqual(checkRepo(bad), null, bad)
    }
  })

  // searches_the_names_of_the_owners_repositories
  it("searches the names of the owners' repositories", () => {
    const owners = ["me", "acme"]
    assert.strictEqual(searchQuery("dk", owners), "dk in:name fork:true user:me user:acme")
    // What's typed can't add qualifiers of its own.
    assert.strictEqual(searchQuery('web app:x "q"', owners), "web app x q in:name fork:true user:me user:acme")
    assert.strictEqual(searchQuery("jenkinsci/gitlab", owners), "gitlab in:name fork:true user:jenkinsci")
    assert.strictEqual(searchQuery("jenkinsci/", owners), "in:name fork:true user:jenkinsci")
    assert.strictEqual(searchQuery("/gitlab", owners), "gitlab in:name fork:true user:me user:acme")
    assert.strictEqual(searchQuery("  ", owners), null)
    assert.strictEqual(searchQuery("::", owners), null)
  })

  // repositories_are_what_the_dialog_shows
  it("shows a repository as the dialog does, from either API", () => {
    const r = {
      full_name: "o/r",
      name: "r",
      description: null,
      private: true,
      fork: false,
      archived: false,
      pushed_at: "2026-10-26T23:45:48Z",
      html_url: "https://github.com/o/r",
      owner: { login: "o" },
    }
    assert.deepStrictEqual(restRepo(r), {
      full_name: "o/r",
      name: "r",
      description: null,
      private: true,
      fork: false,
      archived: false,
      pushed_at: "2026-10-26T23:45:48Z",
      url: "https://github.com/o/r",
    })
    assert.strictEqual(restRepo({ name: "r" }), null)
    const node = {
      nameWithOwner: "o/r",
      name: "r",
      description: null,
      isPrivate: true,
      isFork: false,
      isArchived: false,
      pushedAt: "2026-10-26T23:45:48Z",
      url: "https://github.com/o/r",
    }
    assert.deepStrictEqual(graphqlRepo(node), restRepo(r))
  })

  // lists_each_repository_once_most_recently_pushed_first
  it("lists each repository once, most recently pushed first", () => {
    const list = latestFirst([
      pushedAt("me/old", "2024-01-01T00:00:00Z"),
      pushedAt("org/new", "2026-10-26T00:00:00Z"),
      pushedAt("me/empty", null),
      pushedAt("ORG/new", null),
    ])
    assert.deepStrictEqual(
      list.map((x) => x.full_name),
      ["org/new", "me/old", "me/empty"],
    )
  })

  // gh_errors_end_with_what_it_said_last
  it("says what gh said last when it failed", () => {
    assert.strictEqual(ghError(""), "gh failed")
    assert.strictEqual(ghError("1\n2\n\n3\n4\n5\n6\n7\n"), "2 3 4 5 6 7")
    // Why a clone failed is before git's advice.
    const ssh =
      "Cloning into '/tmp/x'...\ngit@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n\n" +
      "Please make sure you have the correct access rights\nand the repository exists.\nfailed to run git: exit status 128\n"
    assert.strictEqual(
      ghError(ssh),
      "git@github.com: Permission denied (publickey). fatal: Could not read from remote repository. Please make sure you have the correct " +
        "access rights and the repository exists. failed to run git: exit status 128",
    )
  })

  it("reads the accounts gh is signed in to, by host", () => {
    const status = {
      hosts: {
        "github.com": [
          { login: "me", active: true, state: "success" },
          { login: "work", active: false, state: "error" },
        ],
        "ghe.example.com": [{ login: "Me", active: true, state: "success" }],
      },
    }
    assert.deepStrictEqual(accountsFromStatus(status), [
      { account: "ghe.example.com/Me", host: "ghe.example.com", login: "Me", active: true, ok: true },
      { account: "me", host: "github.com", login: "me", active: true, ok: true },
      { account: "work", host: "github.com", login: "work", active: false, ok: false },
    ])
    assert.deepStrictEqual(accountsFromStatus("nope"), [])
  })
})
