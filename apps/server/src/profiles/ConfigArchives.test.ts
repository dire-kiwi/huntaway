import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
import { tempDir, TestBoard } from "@huntaway/testing"
import { AgentConfigs } from "./AgentConfigs.ts"
import { ConfigArchives, decodeArchive } from "./ConfigArchives.ts"

// A config's login and settings exported from one folder and imported into another (the old `api/claude_configs.ts`
// archives, which the old suite only reached through its HTTP routes' auth checks).

const fsDo = <A, E>(f: (fs: FileSystem.FileSystem) => Effect.Effect<A, E>) => Effect.flatMap(FileSystem.FileSystem, (fs) => f(fs).pipe(Effect.orDie))

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
    }).pipe(Effect.provide(TestBoard()), Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it("takes standard base64 with its padding only", () => {
    assert.strictEqual(decodeArchive("aGk=")._tag, "Success")
    for (const bad of ["aGk", "a-k=", "aGk=="]) assert.strictEqual(decodeArchive(bad)._tag, "Failure", bad)
  })
})
