import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Redacted, Schema, Stream } from "effect"
import { AgentConfig, AgentConfigId, AgentConfigPatch } from "@huntaway/contracts"
import { tempDir, TestBoard } from "@huntaway/testing"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { AgentConfigRepo } from "./AgentConfigRepo.ts"
import { AgentConfigs } from "./AgentConfigs.ts"
import { Profiles } from "./Profiles.ts"

/** A task row with only what the table needs, for the facts a config's changes check. */
const insertTask = (profileId: string, columns: { readonly claude_config_id?: string; readonly session_id?: string; readonly running?: number }) =>
  Effect.gen(function* () {
    const { sql } = yield* Db
    const id = `t-${profileId}-${columns.session_id ?? ""}-${columns.running ?? 0}`
    yield* sql`INSERT INTO tasks ${sql.insert({ id, profile_id: profileId, title: "t", last_activity_at: "", created_at: "", updated_at: "", ...columns })}`
    return id
  }).pipe(Effect.orDie)

/** A value as JSON text, to look for what must not be in it. */
const json = (value: unknown) => Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value).pipe(Effect.orDie)
const reason = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  Effect.map(Effect.flip(effect), (e) => ("reason" in e && typeof e.reason === "string" ? e.reason : e._tag))

describe("AgentConfigs", () => {
  // a_config_s_proxy_keys_are_write_only
  it.effect("keeps a config's proxy keys write-only", () =>
    Effect.gen(function* () {
      const configs = yield* AgentConfigs
      const cfg = yield* configs.create({ name: "pool", api_url: " http://10.0.0.7:8317/ ", api_key: "sk-1" })
      assert.deepStrictEqual([cfg.api_url, cfg.has_api_key, cfg.has_management_key], ["http://10.0.0.7:8317", true, false])
      assert.isFalse("api_key" in cfg || "management_key" in cfg)
      // Leaving a key out keeps it; setting another doesn't show it either.
      const cfg2 = yield* configs.update(cfg.id, { management_key: "mk", show_usage: true })
      assert.deepStrictEqual([cfg2.has_api_key, cfg2.has_management_key, cfg2.show_usage], [true, true, true])
      const listed = yield* json(yield* configs.list)
      assert.isFalse(listed.includes("sk-1") || listed.includes('"mk"'), listed)
      const keys = yield* (yield* AgentConfigRepo).keys(cfg.id)
      assert.deepStrictEqual([keys.api_key && Redacted.value(keys.api_key), keys.management_key && Redacted.value(keys.management_key)], ["sk-1", "mk"])
      for (const [patch, want] of [
        [{ api_url: "ftp://x" }, "api_url must be an http:// or https:// URL"],
        [{ api_url: "nope" }, "api_url isn't a URL"],
        [{ agent: "codex" }, "a proxy is for Claude Code configs; clear api_url first"],
      ] as const) {
        assert.strictEqual(yield* reason(configs.update(cfg.id, patch)), want)
      }
      // Blank clears it.
      const cfg3 = yield* configs.update(cfg.id, { api_url: "", api_key: null, management_key: " " })
      assert.deepStrictEqual([cfg3.api_url, cfg3.has_api_key, cfg3.has_management_key], [null, false, false])
      assert.strictEqual((yield* configs.update(cfg.id, { agent: "codex" })).agent, "codex")
      assert.strictEqual(yield* reason(configs.update(cfg.id, { api_url: "http://x:1" })), "a proxy is for Claude Code configs; clear api_url first")
      const e = yield* reason(configs.create({ name: "cx", agent: "codex", api_url: "http://x:1" }))
      assert.strictEqual(e, "a proxy is for Claude Code configs")
    }).pipe(Effect.provide(TestBoard())),
  )

  // claude_config_fields_must_be_strings: the contract refuses the wrong types; an empty folder is the agent's default.
  it.effect("refuses fields of the wrong type and a blank name, and takes an empty folder", () =>
    Effect.gen(function* () {
      for (const bad of [{ config_dir: 3 }, { config_dir: null }, { name: false }, { agent: 1 }, { agent: "gemini" }]) {
        assert.strictEqual((yield* Effect.result(Schema.decodeUnknownEffect(AgentConfigPatch)(bad)))._tag, "Failure")
      }
      const configs = yield* AgentConfigs
      const cfg = yield* configs.create({ name: "c", config_dir: " /claude/c " })
      assert.strictEqual(cfg.config_dir, "/claude/c")
      assert.strictEqual(yield* reason(configs.update(cfg.id, { name: " " })), "name is required")
      assert.strictEqual(yield* reason(configs.create({ name: " " })), "name is required")
      assert.strictEqual((yield* configs.update(cfg.id, { config_dir: "" })).config_dir, "")
      assert.strictEqual((yield* Effect.flip(configs.update(AgentConfigId.make("gone"), {})))._tag, "AgentConfigNotFound")
    }).pipe(Effect.provide(TestBoard())),
  )

  // a_config_whose_settings_send_claude_to_a_proxy_has_it_without_passing_it_on
  it.effect("shows the proxy its folder's settings.json sends Claude Code to", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const configs = yield* AgentConfigs
      const dir = yield* tempDir
      const settings = `${dir}/settings.json`
      const cfg = yield* configs.create({ name: "personal", config_dir: dir })
      const url = Effect.map(configs.list, (list) => list.find((c) => c.id === cfg.id)?.settings_api_url)
      assert.strictEqual(yield* url, null)
      yield* fs.writeFileString(settings, yield* json({ env: { FOO: "1" } }))
      assert.strictEqual(yield* url, null)
      yield* fs.writeFileString(settings, yield* json({ env: { ANTHROPIC_BASE_URL: " http://192.168.50.206:8317/ ", ANTHROPIC_AUTH_TOKEN: "sk-x" } }))
      assert.strictEqual(yield* url, "http://192.168.50.206:8317")
      assert.isFalse((yield* json(yield* configs.list)).includes("sk-x"))
      for (const text of [yield* json({ env: { ANTHROPIC_BASE_URL: "nope" } }), "{"]) {
        yield* fs.writeFileString(settings, text)
        assert.strictEqual(yield* url, null, text)
      }
      // Codex configs don't have one.
      yield* fs.writeFileString(settings, yield* json({ env: { ANTHROPIC_BASE_URL: "http://10.0.0.6:8317" } }))
      assert.strictEqual((yield* configs.update(cfg.id, { agent: "codex" })).settings_api_url, null)
    }).pipe(Effect.scoped, Effect.provide(TestBoard())),
  )

  // a_config_is_sent_with_the_fields_its_wire_type_declares_and_never_its_keys
  it.effect("is sent with the fields its wire type declares and never its keys", () =>
    Effect.gen(function* () {
      const configs = yield* AgentConfigs
      const cfg = yield* configs.create({ name: "c", api_url: "http://proxy", api_key: "the-key", management_key: "the-management-key" })
      assert.deepStrictEqual(Object.keys(cfg).toSorted(), Object.keys(AgentConfig.fields).toSorted())
      for (const text of [yield* json(cfg), yield* json(yield* configs.list)]) {
        assert.isTrue(text.includes('"has_api_key":true') && text.includes('"has_management_key":true'), text)
        assert.isFalse(text.includes("the-key") || text.includes("the-management-key") || text.includes('"api_key"'), text)
      }
    }).pipe(Effect.provide(TestBoard())),
  )

  it.effect("deleting a config takes it off every profile and project, and is refused while agents run with it", () =>
    Effect.gen(function* () {
      const configs = yield* AgentConfigs
      const profiles = yield* Profiles
      const a = yield* configs.create({ name: "a" })
      const b = yield* configs.create({ name: "b" })
      const p = yield* profiles.create({ name: "work", claude_config_ids: [a.id, b.id], assistant_config_id: a.id, threads_config_id: b.id })
      const { sql } = yield* Db
      yield* sql`INSERT INTO projects (id, profile_id, name, key, repo_path, scratch_path, worktrees_root, created_at, claude_config_ids)
        VALUES ('pa', ${p.id}, 'pa', 'PA', '/x', '/s', '/w', '', ${yield* json([a.id])}), ('pb', ${p.id}, 'pb', 'PB', '/x', '/s', '/w', '', ${yield* json([a.id, b.id])})`.pipe(
        Effect.orDie,
      )
      const running = yield* insertTask(p.id, { claude_config_id: a.id, running: 1 })
      assert.strictEqual((yield* Effect.flip(configs.delete(a.id)))._tag, "Conflict")
      yield* sql`DELETE FROM tasks WHERE id = ${running}`.pipe(Effect.orDie)
      const watch = yield* (yield* Events).watch(undefined)
      yield* configs.delete(a.id)
      const after = yield* profiles.get(p.id)
      assert.deepStrictEqual([after.claude_config_ids, after.assistant_config_id, after.threads_config_id], [[b.id], null, b.id])
      const projects = yield* sql<{ readonly id: string; readonly ids: string | null }>`SELECT id, claude_config_ids AS ids FROM projects ORDER BY id`.pipe(
        Effect.orDie,
      )
      assert.deepStrictEqual(
        projects.map((r) => [r.id, r.ids]),
        [
          ["pa", null],
          ["pb", yield* json([b.id])],
        ],
      )
      const [event] = yield* watch.live.pipe(Stream.take(1), Stream.runCollect)
      assert.deepStrictEqual(event?.type === "profiles_changed" ? event.configs.map((c) => c.name) : null, ["b"])
      assert.strictEqual((yield* Effect.flip(configs.delete(a.id)))._tag, "AgentConfigNotFound")
    }).pipe(Effect.scoped, Effect.provide(TestBoard())),
  )

  it.effect("won't change the agent of a config that threads have conversations in", () =>
    Effect.gen(function* () {
      const configs = yield* AgentConfigs
      const cfg = yield* configs.create({ name: "c" })
      const p = yield* (yield* Profiles).create({ name: "work", claude_config_ids: [cfg.id] })
      yield* insertTask(p.id, { claude_config_id: cfg.id, session_id: "s" })
      const e = yield* reason(configs.update(cfg.id, { agent: "codex" }))
      assert.strictEqual(e, "has_session")
      assert.strictEqual((yield* configs.update(cfg.id, { agent: "claude", name: "d" })).name, "d", "the same agent is no change")
    }).pipe(Effect.provide(TestBoard())),
  )
})
