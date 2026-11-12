import { assert, describe, it } from "@effect/vitest"
import { Result } from "effect"
import {
  checkDisabledSkills,
  checkRef,
  checkServerConfig,
  checkServerName,
  checkSkill,
  checkSubdir,
  frontmatter,
  MAX_DESCRIPTION,
  normalizeUrl,
  sourceName,
  validOtherSkill,
} from "./validation.ts"
import { toolPrefix } from "../claude/access.ts"

// huntaway's agent/agent_tools/tests.test.ts (reads_skill_frontmatter, checks_skills, saved_bad_skill_names_dont_block_toggles,
// checks_server_configs, names_server_tools_like_claude_code) and sources/tests.test.ts (normalizes_what_to_clone, the
// subfolder's checks).

const ok = <A, E>(r: Result.Result<A, E>): A | undefined => {
  assert.isTrue(Result.isSuccess(r), "expected success")
  return Result.isSuccess(r) ? r.success : undefined
}
const fails = <A, E>(r: Result.Result<A, E>, what: string) => assert.isTrue(Result.isFailure(r), what)

const invocable = (v: string) => frontmatter(`---\nname: x\nuser-invocable: ${v}\n---\n`)?.user_invocable
const long = (n: number) => `---\nname: ok\ndescription: ${"é".repeat(n)}\n---\n`

describe("agent tools' checks", () => {
  it("reads a skill's frontmatter", () => {
    assert.deepStrictEqual(frontmatter('---\nname: deploy\ndescription: "Deploy the app"\nallowed-tools: Bash\n---\n\nBody\n'), {
      name: "deploy",
      description: "Deploy the app",
      user_invocable: true,
    })
    assert.deepStrictEqual(frontmatter("---\nname: 'x'\ndescription: >\n  Folded\n  text\nother: 1\nuser-invocable: false\n---\n"), {
      name: "x",
      description: "Folded text",
      user_invocable: false,
    })
    // As Claude Code reads it.
    for (const v of ["true", "TRUE", "Yes", "on", "1", "true # x", '"true"', "'yes' # x"]) assert.isTrue(invocable(v), v)
    for (const v of ["false", "FALSE", "no", "off", "0", "false # Only the model", "'false'", '"true # x"', "", "# x", "maybe", "true maybe"])
      assert.isFalse(invocable(v), v)
    assert.isTrue(frontmatter("---\nname: x\n---\n")?.user_invocable)
    assert.isNull(frontmatter("no frontmatter"))
    assert.isNull(frontmatter("---\nname: unterminated\n"))
  })

  it("checks skills, and the names of others' skills to turn off", () => {
    ok(checkSkill("---\nname: ok-1\ndescription: d\n---\n"))
    fails(checkSkill("---\nname: Bad Name\ndescription: d\n---\n"), "bad name")
    fails(checkSkill("---\nname: ok\n---\n"), "no description")
    fails(checkSkill("# just markdown"), "no frontmatter")
    ok(checkSkill(long(MAX_DESCRIPTION)))
    fails(checkSkill(long(MAX_DESCRIPTION + 1)), "too long")
    assert.isTrue(validOtherSkill("pdf") && validOtherSkill("my-plugin:do_it") && validOtherSkill("Legacy.Command"))
    assert.isFalse(validOtherSkill("two words") || validOtherSkill("x)") || validOtherSkill("a,b") || validOtherSkill(""))
  })

  it("lets saved bad skill names through, so they don't block toggles", () => {
    const saved = ["old one", "other bad", "pdf"]
    assert.deepStrictEqual(ok(checkDisabledSkills(saved, ["docx", "old one", "other bad", "pdf"])), ["docx", "old one", "other bad", "pdf"])
    assert.deepStrictEqual(ok(checkDisabledSkills(saved, ["other bad"])), ["other bad"])
    // New bad names are still refused.
    fails(checkDisabledSkills(saved, ["new bad", "pdf"]), "a new bad name")
  })

  it("checks servers' configs and names", () => {
    assert.strictEqual(ok(checkServerConfig({ url: "https://x" }))?.type, "http")
    assert.strictEqual(ok(checkServerConfig({ command: "npx", args: ["-y", "pkg"] }))?.type, "stdio")
    // Settings the form doesn't show stay.
    assert.strictEqual(ok(checkServerConfig({ command: "x", timeout: 5 }))?.["timeout"], 5)
    fails(checkServerConfig({ type: "stdio" }), "no command")
    fails(checkServerConfig({ command: "x", args: "-y" }), "args a string")
    fails(checkServerConfig({ url: "https://x", headers: { a: 1 } }), "a header not a string")
    fails(checkServerConfig({ type: "ws", url: "x" }), "ws")
    fails(checkServerConfig("x"), "not an object")
    fails(checkServerName("huntaway"), "the board's")
    fails(checkServerName("has space"), "a space")
    ok(checkServerName("my-server_2"))
  })

  it("names servers' tools like Claude Code", () => {
    assert.strictEqual(toolPrefix("claude.ai Google Drive"), "mcp__claude_ai_Google_Drive")
    assert.strictEqual(toolPrefix("my-server_2"), "mcp__my-server_2")
  })

  it("normalizes what to clone", () => {
    assert.strictEqual(ok(normalizeUrl("danyuchn/asd-ste100-skill")), "https://github.com/danyuchn/asd-ste100-skill")
    assert.strictEqual(ok(normalizeUrl(" owner/repo.git ")), "https://github.com/owner/repo")
    assert.strictEqual(ok(normalizeUrl("https://github.com/o/r")), "https://github.com/o/r")
    assert.strictEqual(ok(normalizeUrl("git@github.com:o/r.git")), "git@github.com:o/r.git")
    assert.strictEqual(ok(normalizeUrl("ssh://git@host/o/r")), "ssh://git@host/o/r")
    assert.strictEqual(ok(normalizeUrl("/srv/repo")), "/srv/repo")
    for (const bad of [
      "",
      "  ",
      "--upload-pack=x",
      "-c",
      "ext::sh -c id",
      "ext::sh%20-c%20id",
      "fd::3",
      "ftp://x/y",
      "a/b/c",
      "../x",
      "owner",
      "https://x y",
      "a/b\nc",
      "./rel/path",
    ])
      fails(normalizeUrl(bad), `[${bad}]`)
    assert.isNull(ok(checkRef(null)))
    assert.isNull(ok(checkRef("  ")))
    assert.strictEqual(ok(checkRef("v1.2/x")), "v1.2/x")
    for (const bad of ["--foo", "a b", "a..b", "/x", "a;b"]) fails(checkRef(bad), bad)
    assert.strictEqual(sourceName("https://github.com/o/my-skills.git"), "my-skills")
    assert.strictEqual(sourceName("git@host:o/r"), "r")
    assert.strictEqual(sourceName("/srv/repos/skills/"), "skills")
  })

  it("checks a source's subfolder", () => {
    assert.strictEqual(ok(checkSubdir(" /skills/en/ ")), "skills/en")
    assert.strictEqual(ok(checkSubdir("./skills//en")), "skills/en")
    assert.isNull(ok(checkSubdir("")))
    assert.isNull(ok(checkSubdir(null)))
    for (const bad of ["../x", "skills/../..", ".git", "a\\b", "a\u0000b"]) fails(checkSubdir(bad), bad)
  })
})
