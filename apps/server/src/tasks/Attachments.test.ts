import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Queue, Result } from "effect"
import type { Scope } from "effect"
import { Base64 } from "effect/encoding"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { TaskId } from "@huntaway/contracts"
import { TestPlatform } from "@huntaway/testing"
import { DataDir } from "../platform/DataDir.ts"
import { Attachments, cleanName, decodeStrictBase64, idsIn, MAX_BYTES, mime, UNUSED_FOR_MILLIS } from "./Attachments.ts"

// huntaway's attachments.test.ts, and the upload, download and pruner it had no tests for. On the platform alone (an
// in-memory database brought up to date, a temp data folder) with `Attachments` and no pruner running behind the test.

const A = "0123456789abcdef0123456789abcdef"
const B = "fedcba9876543210fedcba9876543210"
/** The test clock's "now": 12 November 2026. */
const NOW = 1_794_441_600_000
const HOUR = 60 * 60 * 1000

const run = <A, E>(effect: Effect.Effect<A, E, Attachments | DataDir | FileSystem.FileSystem | SqlClient.SqlClient | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(Attachments.layer.pipe(Layer.provideMerge(TestPlatform()))))

/** A profile and a task row, with only what the table needs. */
const insertTask = (id: string, description: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT OR IGNORE INTO profiles (id, name, created_at) VALUES ('me', 'me', '')`
    yield* sql`INSERT INTO tasks ${sql.insert({ id, profile_id: "me", title: id, description, last_activity_at: "", created_at: "", updated_at: "" })}`
    return TaskId.make(id)
  }).pipe(Effect.orDie)

/** An attachment's folder, last changed `ageMillis` before `NOW`. */
const folder = (id: string, ageMillis: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = (yield* DataDir).attachment(id)
    yield* fs.makeDirectory(path, { recursive: true })
    yield* fs.writeFileString(`${path}/x.png`, "x")
    const seconds = (NOW - ageMillis) / 1000
    yield* fs.utimes(path, seconds, seconds)
    return path
  }).pipe(Effect.orDie)

/** A message with a file listed, as the UI sends it; and a thread item's JSON that has one. */
const listed = (id: string) => `Attached files:\n- /data/attachments/${id}/x.png`
const inJson = (id: string) => `{"text":"Attached files:\\n- /data/attachments/${id}/x.png"}`

const exists = (path: string) => Effect.flatMap(FileSystem.FileSystem, (fs) => fs.exists(path)).pipe(Effect.orDie)

describe("attachments, pure", () => {
  it("finds the ids messages refer to, Windows paths in JSON too", () => {
    const text = `Attached files:\n- /home/me/.local/share/huntaway/attachments/${A}/x.png\n{"text":"C:\\\\data\\\\attachments\\\\${B}\\\\y.txt"}`
    assert.deepStrictEqual(idsIn(text), [A, B])
    assert.strictEqual(idsIn("attachments/0123/x attachments attachments/").length, 0)
  })

  it("cleans names into one safe path segment", () => {
    assert.strictEqual(cleanName("Screenshot 2026-10-24 at 10.00.png"), "Screenshot_2026-10-24_at_10.00.png")
    assert.strictEqual(cleanName("../../etc/passwd"), "passwd")
    assert.strictEqual(cleanName("..\\x.txt"), "x.txt")
    assert.strictEqual(cleanName(".."), "file")
    assert.strictEqual(cleanName(".env"), "env")
    assert.strictEqual(cleanName("ü.png"), "_.png")
    const long = cleanName(`${"a".repeat(200)}.png`)
    assert.strictEqual(long.length, 100)
    assert.isTrue(long.endsWith(".png"))
  })

  // HA-138: voice notes are audio.
  it("knows a file's type by its extension", () => {
    assert.strictEqual(mime("voice-note-1.wav"), "audio/wav")
    assert.strictEqual(mime("memo.M4A"), "audio/mp4")
    assert.strictEqual(mime("x.caf"), "audio/x-caf")
    assert.strictEqual(mime("x.png"), "image/png")
    assert.strictEqual(mime("Makefile"), "application/octet-stream")
  })

  it("takes only strict base64: padded, the standard alphabet", () => {
    assert.deepStrictEqual(
      Result.map(decodeStrictBase64("aGk="), (b) => [...b]),
      Result.succeed([104, 105]),
    )
    for (const bad of ["aGk", "aG-_", "aGk=\n", "a=Gk", "aGk==="]) assert.isTrue(Result.isFailure(decodeStrictBase64(bad)), bad)
  })
})

describe("Attachments", () => {
  it.effect("saves an upload under a clean name and gives it back", () =>
    run(
      Effect.gen(function* () {
        const attachments = yield* Attachments
        const dataDir = yield* DataDir
        const saved = yield* attachments.upload("../My notes.txt", ` ${Base64.encode("hello")}\n`)
        assert.match(saved.id, /^[0-9a-f]{32}$/)
        assert.deepStrictEqual(
          [saved.name, saved.size, saved.mime, saved.path],
          ["My_notes.txt", 5, "text/plain", `${dataDir.attachment(saved.id)}/My_notes.txt`],
        )
        const got = yield* attachments.get(saved.id, saved.name)
        assert.deepStrictEqual(got, { name: "My_notes.txt", size: 5, mime: "text/plain", data: Base64.encode("hello") })
        // Only a saved file, by its id and its clean name.
        for (const [id, name] of [
          [saved.id, "../My_notes.txt"],
          [saved.id, "My notes.txt"],
          ["../x", saved.name],
          [saved.id.slice(1), saved.name],
          [A, saved.name],
        ] as const) {
          assert.strictEqual((yield* Effect.flip(attachments.get(id, name)))._tag, "AttachmentNotFound", `${id}/${name}`)
        }
      }),
    ),
  )

  it.effect("refuses data that isn't strict base64, and a file over 10 MiB", () =>
    run(
      Effect.gen(function* () {
        const attachments = yield* Attachments
        const refused = yield* Effect.flip(attachments.upload("x.txt", "aGk"))
        assert.deepStrictEqual([refused.field, refused.reason], ["data", "data must be base64"])
        assert.strictEqual((yield* attachments.upload("ok.bin", Base64.encode(new Uint8Array(MAX_BYTES)))).size, MAX_BYTES)
        const over = yield* Effect.flip(attachments.upload("big.bin", Base64.encode(new Uint8Array(MAX_BYTES + 1))))
        assert.match(over.reason, /big\.bin is larger than 10 MB/)
      }),
    ),
  )

  it.effect("finds a task's references in its description, queued and steered messages, and thread", () =>
    run(
      Effect.gen(function* () {
        const attachments = yield* Attachments
        const sql = yield* SqlClient.SqlClient
        const ids = ["a", "b", "c", "d", "e"].map((c) => c.repeat(32))
        const task = yield* insertTask("t", listed(ids[0] ?? ""))
        yield* sql`INSERT INTO task_queue (task_id, text, source, created_at) VALUES (${task}, ${listed(ids[1] ?? "")}, 'user', '')`
        // Messages the agent hasn't read yet.
        yield* sql`INSERT INTO task_steers (id, seq, task_id, run_id, text, source, created_at) VALUES ('s', 1, ${task}, 'r', ${listed(ids[2] ?? "")}, 'user', '')`
        yield* sql`INSERT INTO thread_items (task_id, id, pos, type, data, created_at, updated_at) VALUES (${task}, 'i', 1, 'user', ${inJson(ids[3] ?? "")}, '', '')`
        yield* sql`INSERT INTO thread_requests (task_id, id, pos, type, open, data, created_at, updated_at) VALUES (${task}, 'q', 1, 'question', 1, ${inJson(ids[4] ?? "")}, '', '')`
        yield* insertTask("other", "nothing attached")
        assert.deepStrictEqual([...(yield* attachments.ofTask(task))].toSorted(), ids)
        assert.deepStrictEqual([...(yield* attachments.referenced)].toSorted(), ids)
        assert.deepStrictEqual([...(yield* attachments.ofTask(TaskId.make("other")))], [])
      }),
    ),
  )

  // HA-341: an agent was given the whole attachments folder, every profile's files in it.
  it.effect("gives an agent only its own task's attachments, and those of the prompt it starts with", () =>
    run(
      Effect.gen(function* () {
        const attachments = yield* Attachments
        const dataDir = yield* DataDir
        const [mine, theirs, sent, gone] = ["a", "b", "c", "d"].map((x) => x.repeat(32))
        for (const id of [mine, theirs, sent]) yield* folder(id ?? "", 0)
        const at = (id: string | undefined) => `Attached files:\n- ${dataDir.attachment(id ?? "")}/x.png`
        const task = yield* insertTask("mine", `${at(mine)}\n${at(gone)}`)
        yield* insertTask("theirs", at(theirs))
        const dirs = yield* attachments.dirsFor(task, `Look\n\n${at(sent)}`)
        assert.deepStrictEqual(dirs.toSorted(), [dataDir.attachment(mine ?? ""), dataDir.attachment(sent ?? "")])
      }),
    ),
  )

  it.effect("removes the folders nothing refers to after a task goes, and those a week old when pruning", () =>
    run(
      Effect.gen(function* () {
        const attachments = yield* Attachments
        yield* TestClock.setTime(NOW)
        const old = yield* folder(A, UNUSED_FOR_MILLIS + HOUR)
        const kept = yield* folder(B, UNUSED_FOR_MILLIS + HOUR)
        const fresh = yield* folder("c".repeat(32), UNUSED_FOR_MILLIS - HOUR)
        yield* insertTask("t", `see attachments/${B}/x.png`)
        // A draft has a week to be sent; one a task refers to stays.
        assert.strictEqual(yield* attachments.prune, 1)
        assert.deepStrictEqual([yield* exists(old), yield* exists(kept), yield* exists(fresh)], [false, true, true])
        // After a task is deleted, its files go at once unless another task refers to them.
        yield* attachments.removeUnreferenced(new Set([B, "c".repeat(32)]))
        assert.deepStrictEqual([yield* exists(kept), yield* exists(fresh)], [true, false])
      }),
    ),
  )

  it.effect("prunes when the server starts and every 6 hours after", () =>
    run(
      Effect.gen(function* () {
        const attachments = yield* Attachments
        yield* TestClock.setTime(NOW)
        // A week old less an hour: not yet.
        const draft = yield* folder(A, UNUSED_FOR_MILLIS - HOUR)
        const runs = yield* Queue.unbounded<number>()
        const counted = Layer.succeed(
          Attachments,
          Attachments.of({
            upload: attachments.upload,
            get: attachments.get,
            ofTask: attachments.ofTask,
            referenced: attachments.referenced,
            dirsFor: attachments.dirsFor,
            removeUnreferenced: attachments.removeUnreferenced,
            prune: Effect.tap(attachments.prune, (n) => Queue.offer(runs, n)),
          }),
        )
        yield* Layer.build(Attachments.pruner.pipe(Layer.provide(counted)))
        assert.strictEqual(yield* Queue.take(runs), 0)
        assert.isTrue(yield* exists(draft))
        yield* TestClock.adjust("6 hours")
        assert.strictEqual(yield* Queue.take(runs), 1)
        assert.isFalse(yield* exists(draft))
      }),
    ),
  )
})
