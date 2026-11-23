import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer } from "effect"
import { Digest } from "effect/crypto"
import { tempDir, TestBoard } from "@huntaway/testing"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { AgentConfigs } from "./AgentConfigs.ts"
import { ConfigArchives, decodeArchive } from "./ConfigArchives.ts"

// A config's login and settings exported from one folder and imported into another (the old `api/claude_configs.ts`
// archives, which the old suite only reached through its HTTP routes' auth checks).

const fsDo = <A, E>(f: (fs: FileSystem.FileSystem) => Effect.Effect<A, E>) => Effect.flatMap(FileSystem.FileSystem, (fs) => f(fs).pipe(Effect.orDie))

// HE-87: a Mac keeps Claude Code's logins in the keychain; this fake `security` keeps each item as a file in
// `<home>/keychain`, read with `find-generic-password -a <account> -w -s <service>` and written through `-i`.
const fakeSecurity = (home: string) => String.raw`#!/bin/sh
items='${home}/keychain'
if [ "$1" = "find-generic-password" ]; then
  [ -f "$items/$6" ] || exit 44
  cat "$items/$6"; echo; exit 0
fi
if [ "$1" = "-i" ]; then
  read -r line
  service=$(printf '%s' "$line" | cut -d'"' -f4)
  data=$(printf '%s' "$line" | cut -d'"' -f6 | sed 's/../\\x&/g')
  printf "$data" > "$items/$service"
fi
exit 0
`

/** A board on a "Mac", in a home folder of its own, with the fake keychain. */
const macBoard = Layer.unwrap(
  Effect.gen(function* () {
    const home = yield* tempDir
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(`${home}/security`, fakeSecurity(home))
    yield* fs.chmod(`${home}/security`, 0o755)
    return TestBoard({ home, platform: "mac-arm64", securityBin: `${home}/security` })
  }).pipe(Effect.orDie),
)

describe("ConfigArchives", () => {
  it.live("copies a config's login and settings, and nothing else, into another config's folder", () =>
    Effect.gen(function* () {
      const archives = yield* ConfigArchives
      const configs = yield* AgentConfigs
      const dir = yield* tempDir
      const [from, to] = [`${dir}/from`, `${dir}/to/nested`]
      yield* fsDo((fs) => fs.makeDirectory(`${from}/skills/s`, { recursive: true }))
      yield* fsDo((fs) => fs.makeDirectory(`${from}/projects/p`, { recursive: true }))
      for (const [f, text] of [
        [".credentials.json", "{}"],
        ["settings.json", "{}"],
        ["skills/s/SKILL.md", "skill"],
        ["history.jsonl", "secret history"],
        ["projects/p/session.jsonl", "a conversation"],
      ] as const)
        yield* fsDo((fs) => fs.writeFileString(`${from}/${f}`, text))
      const a = yield* configs.create({ name: "a", config_dir: from })
      const b = yield* configs.create({ name: "b", config_dir: to })

      const out = yield* archives.exportArchive(a.id)
      assert.deepStrictEqual(out.files, [".credentials.json", "settings.json", "skills"])
      assert.isAbove(out.bytes, 0)
      assert.deepStrictEqual(yield* archives.importArchive(b.id, out.archive, false), { dir: to })
      assert.strictEqual(yield* fsDo((fs) => fs.readFileString(`${to}/skills/s/SKILL.md`)), "skill")
      assert.isFalse(yield* fsDo((fs) => fs.exists(`${to}/history.jsonl`)), "history stays behind")
      assert.isFalse(yield* fsDo((fs) => fs.exists(`${to}/projects`)), "conversations stay behind")
      assert.strictEqual((yield* fsDo((fs) => fs.stat(to))).mode & 0o777, 0o700)

      // A login there already is replaced only when asked.
      const refused = yield* Effect.flip(archives.importArchive(b.id, out.archive, false))
      assert.strictEqual(refused._tag, "Conflict")
      assert.include(refused._tag === "Conflict" ? refused.detail : "", "already has a login")
      yield* archives.importArchive(b.id, out.archive, true)

      // What isn't base64 or a tar is refused; a folder with nothing to copy has no archive.
      for (const bad of ["not base64!", "aGVsbG8="]) assert.strictEqual((yield* Effect.flip(archives.importArchive(b.id, bad, true)))._tag, "Invalid")
      const empty = yield* configs.create({ name: "c", config_dir: `${dir}/empty` })
      assert.strictEqual((yield* Effect.flip(archives.exportArchive(empty.id)))._tag, "Invalid")
      // A Codex config's own entries.
      yield* fsDo((fs) => fs.makeDirectory(`${dir}/codex`, { recursive: true }))
      yield* fsDo((fs) => fs.writeFileString(`${dir}/codex/auth.json`, "{}"))
      yield* fsDo((fs) => fs.writeFileString(`${dir}/codex/settings.json`, "{}"))
      const codex = yield* configs.create({ name: "x", config_dir: `${dir}/codex`, agent: "codex" })
      assert.deepStrictEqual((yield* archives.exportArchive(codex.id)).files, ["auth.json"])
      // An ACP agent's (Antigravity's home), its sign-in in a folder of its own.
      yield* fsDo((fs) => fs.makeDirectory(`${dir}/gemini/antigravity-acp/tmp`, { recursive: true }))
      for (const f of ["antigravity-acp/acp_token.json", "antigravity-acp/tmp/x", "settings.json", "history.jsonl"])
        yield* fsDo((fs) => fs.writeFileString(`${dir}/gemini/${f}`, "{}"))
      const acp = yield* configs.create({ name: "g", config_dir: `${dir}/gemini`, agent: "acp" })
      const acpOut = yield* archives.exportArchive(acp.id)
      assert.deepStrictEqual(acpOut.files, ["antigravity-acp/acp_token.json", "settings.json"])
      const acpTo = yield* configs.create({ name: "g2", config_dir: `${dir}/gemini2`, agent: "acp" })
      yield* archives.importArchive(acpTo.id, acpOut.archive, false)
      assert.isTrue(yield* fsDo((fs) => fs.exists(`${dir}/gemini2/antigravity-acp/acp_token.json`)))
      assert.strictEqual((yield* Effect.flip(archives.importArchive(acpTo.id, acpOut.archive, false)))._tag, "Conflict")
    }).pipe(Effect.provide(TestBoard()), Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.live("on a Mac, copies a Claude login out of the keychain and into it, and tells a terminal's claude whose it is", () =>
    Effect.gen(function* () {
      const archives = yield* ConfigArchives
      const configs = yield* AgentConfigs
      const { home } = yield* ServerConfig
      const digest = yield* Digest.Digest
      const item = (dir: string | null) =>
        dir === null
          ? Effect.succeed(`${home}/keychain/Claude Code-credentials`)
          : Effect.map(digest.digestHex(Digest.sha256, new TextEncoder().encode(dir)), (h) => `${home}/keychain/Claude Code-credentials-${h.slice(0, 8)}`)
      const write = (f: string, text: string) => fsDo((fs) => fs.writeFileString(f, text))
      const read = (f: string) => fsDo((fs) => fs.readFileString(f))
      const login = `{"claudeAiOauth":{"accessToken":"new"}}`

      // The work config's login is only in the keychain, as Claude Code keeps it on a Mac.
      yield* fsDo((fs) => fs.makeDirectory(`${home}/keychain`, { recursive: true }))
      yield* fsDo((fs) => fs.makeDirectory(`${home}/.claude-work`, { recursive: true }))
      yield* write(yield* item(`${home}/.claude-work`), login)
      yield* write(`${home}/.claude-work/.claude.json`, `{"oauthAccount":{"emailAddress":"me@work"},"hasCompletedOnboarding":true,"projects":{"w":1}}`)
      yield* write(`${home}/.claude-work/settings.json`, "{}")
      const work = yield* configs.create({ name: "work", config_dir: "~/.claude-work" })
      const out = yield* archives.exportArchive(work.id)
      assert.deepStrictEqual(out.files, [".credentials.json", ".claude.json", "settings.json"])

      // Into ~/.claude, whose keychain item a plain `claude` in a terminal reads (it has an old login), and its agents'.
      yield* write(yield* item(null), `{"claudeAiOauth":{"accessToken":"old"}}`)
      yield* write(`${home}/.claude.json`, `{"oauthAccount":{"emailAddress":"old@home"},"projects":{"mine":1}}`)
      const main = yield* configs.create({ name: "main", config_dir: "~/.claude" })
      const refused = yield* Effect.flip(archives.importArchive(main.id, out.archive, false))
      assert.strictEqual(refused._tag, "Conflict", "the keychain's login is a login there")
      yield* archives.importArchive(main.id, out.archive, true)
      assert.strictEqual(yield* read(yield* item(null)), login)
      assert.strictEqual(yield* read(yield* item(`${home}/.claude`)), login)
      assert.isFalse(yield* fsDo((fs) => fs.exists(`${home}/.claude/.credentials.json`)), "the login is in the keychain, not the file")
      assert.include(yield* read(`${home}/.claude/.claude.json`), "me@work")
      const terminal = yield* read(`${home}/.claude.json`)
      assert.include(terminal, `"emailAddress":"me@work"`)
      assert.include(terminal, `"hasCompletedOnboarding":true`)
      assert.include(terminal, `"mine":1`, "the rest of it is this host's own")
      assert.notInclude(terminal, `"w":1`)

      // A config in a folder of its own has one item, its agents'; a terminal's claude and its .claude.json are left alone.
      const other = yield* configs.create({ name: "other", config_dir: `${home}/other` })
      yield* archives.importArchive(other.id, out.archive, false)
      assert.strictEqual(yield* read(yield* item(`${home}/other`)), login)
      assert.strictEqual(yield* read(`${home}/.claude.json`), terminal)

      // A keychain that won't take it (locked, say) fails the copy, and says so.
      yield* write(`${home}/security`, "#!/bin/sh\nexit 44\n")
      const locked = yield* Effect.flip(archives.importArchive(other.id, out.archive, true))
      assert.strictEqual(locked._tag, "ArchiveUnavailable")
      assert.include(locked._tag === "ArchiveUnavailable" ? locked.reason : "", "keychain")
    }).pipe(Effect.provide(macBoard), Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it("takes standard base64 with its padding only", () => {
    assert.strictEqual(decodeArchive("aGk=")._tag, "Success")
    for (const bad of ["aGk", "a-k=", "aGk=="]) assert.strictEqual(decodeArchive(bad)._tag, "Failure", bad)
  })
})
