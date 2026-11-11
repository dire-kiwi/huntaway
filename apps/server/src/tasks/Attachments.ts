import { Clock, Context, Effect, FileSystem, Layer, Option, Result, Schedule, Schema } from "effect"
import { SecureRandom } from "effect/crypto"
import { Base64 } from "effect/encoding"
import { SqlSchema } from "effect/sql"
import type { SqlError } from "effect/sql"
import { AttachmentId, Invalid } from "@huntaway/contracts"
import type { Attachment, AttachmentData, TaskId } from "@huntaway/contracts"
import { DataDir } from "../platform/DataDir.ts"
import { Db } from "../platform/Db.ts"

// Files attached to prompts (huntaway's attachments.ts; docs/plan/inventory/07-server-root-api.md, 7.3 and 9): pasted,
// dropped or picked in the UI, saved under `<data dir>/attachments/<id>/<name>`, and listed by path at the end of the
// message. Uploads and downloads are JSON with base64 data, so they travel through a hub like any other call. Nothing
// records which task a file is for: references are found by scanning the texts that can hold a path, and a folder
// nothing refers to is pruned once it is a week old, so a draft has time to be sent.

export class AttachmentNotFound extends Schema.TaggedError<AttachmentNotFound, { readonly brand: unique symbol }>()("AttachmentNotFound", {
  id: Schema.String,
  file: Schema.String,
}) {}

/** The largest file taken: its base64 has to fit in one hub tunnel frame (16 MB). */
export const MAX_BYTES = 10 * 1024 * 1024
/** How long a folder nothing refers to is kept: long enough for a draft to be sent. */
export const UNUSED_FOR_MILLIS = 7 * 24 * 60 * 60 * 1000

// ---- pure ---------------------------------------------------------------------------------------------------------

/** A name that is safe as a path segment and easy to quote: letters, digits, `.`, `-`, `_`; no leading dots; at most 100. */
export const cleanName = (name: string): string => {
  const base = name.split(/[/\\]/).at(-1) ?? ""
  let out = Array.from(base)
    .map((c) => (/^[A-Za-z0-9._-]$/.test(c) ? c : "_"))
    .join("")
    .replace(/^\.+/, "")
  if (out.length > 100) {
    // Keep the extension.
    const i = out.lastIndexOf(".")
    const ext = i >= 0 && out.length - i <= 10 ? out.slice(i) : ""
    out = `${out.slice(0, 100 - ext.length)}${ext}`
  }
  return out === "" ? "file" : out
}

const MIME: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  pdf: "application/pdf",
  json: "application/json",
  txt: "text/plain",
  md: "text/plain",
  log: "text/plain",
  csv: "text/plain",
  diff: "text/plain",
  patch: "text/plain",
  // Voice notes from the app, and audio shared into it.
  wav: "audio/wav",
  m4a: "audio/mp4",
  mp4a: "audio/mp4",
  aac: "audio/aac",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  caf: "audio/x-caf",
}

/** A file's type by its extension. */
export const mime = (name: string): string => MIME[(name.split(".").at(-1) ?? "").toLowerCase()] ?? "application/octet-stream"

/** Ids of the attachments `text` refers to (`…attachments/<32 hex>/…`). In JSON a Windows path's separators are doubled. */
export const idsIn = (text: string): ReadonlyArray<string> => {
  const out: Array<string> = []
  const word = "attachments"
  let i = text.indexOf(word)
  while (i >= 0) {
    const rest = text.slice(i + word.length).replace(/^[/\\]+/, "")
    const id = rest.slice(0, 32)
    if (/^[0-9A-Fa-f]{32}$/.test(id) && /^[/\\]/.test(rest.slice(32))) out.push(id)
    i = text.indexOf(word, i + word.length)
  }
  return out
}

/** Strict base64 (padded, the standard alphabet), as uploads carry it. */
export const decodeStrictBase64 = (data: string): Result.Result<Uint8Array, Invalid> => {
  const bad = Result.fail(new Invalid({ field: "data", reason: "data must be base64" }))
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return bad
  return Result.match(Base64.decode(data), { onFailure: () => bad, onSuccess: (bytes) => Result.succeed(bytes) })
}

/** How many bytes strict base64 `data` decodes to. */
const decodedSize = (data: string): number => (data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0)

// ---- the service --------------------------------------------------------------------------------------------------

/** One text column of the rows that can refer to an attachment. */
const TextRow = Schema.Struct({ text: Schema.NullOr(Schema.String) })
const texts = (statement: Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>) =>
  SqlSchema.findAll({ Request: Schema.Void, Result: TextRow, execute: () => statement })(undefined).pipe(Effect.orDie)
/** The attachment ids the texts refer to. */
const collect = (rows: ReadonlyArray<ReadonlyArray<{ readonly text: string | null }>>): ReadonlySet<string> =>
  new Set(rows.flatMap((list) => list.flatMap((r) => (r.text === null ? [] : idsIn(r.text)))))

export interface AttachmentsShape {
  /** Saves a file (`data` strict base64, at most 10 MiB decoded) under a cleaned name: where it is. */
  readonly upload: (name: string, data: string) => Effect.Effect<Attachment, Invalid>
  /** A saved file, base64. The id must be one (32 hex) and the name a cleaned one. */
  readonly get: (id: string, name: string) => Effect.Effect<AttachmentData, AttachmentNotFound>
  /**
   * The ids a task refers to: its description, queued and steered messages, and its thread's items and requests. A
   * thread's items hold the messages sent to it.
   */
  readonly ofTask: (task: TaskId) => Effect.Effect<ReadonlySet<string>>
  /** The ids any task refers to. */
  readonly referenced: Effect.Effect<ReadonlySet<string>>
  /**
   * The attachment folders a task's agent may read without asking (`--add-dir`): those its thread refers to and those
   * `text` (the prompt it starts with) does. Never the whole folder, which has every profile's files (HA-341).
   */
  readonly dirsFor: (task: TaskId, text: string) => Effect.Effect<ReadonlyArray<string>>
  /** Removes those of `ids` nothing refers to any more (after deleting what did). */
  readonly removeUnreferenced: (ids: ReadonlySet<string>) => Effect.Effect<void>
  /** Removes the folders nothing refers to that are older than a week (by their mtime): how many. Never fails. */
  readonly prune: Effect.Effect<number>
}

/** Uploaded files, and the scan that finds what refers to them. */
export class Attachments extends Context.Service<Attachments, AttachmentsShape>()("huntaway-server/tasks/Attachments") {
  static readonly layer = Layer.effect(
    Attachments,
    Effect.gen(function* () {
      const { sql } = yield* Db
      const dataDir = yield* DataDir
      const fs = yield* FileSystem.FileSystem
      const random = yield* SecureRandom.SecureRandom

      const ofTask = Effect.fn("Attachments.ofTask")(function* (task: TaskId) {
        return collect(
          yield* Effect.all(
            [
              texts(sql`SELECT description AS text FROM tasks WHERE id = ${task}`),
              texts(sql`SELECT text FROM task_queue WHERE task_id = ${task} AND instr(text, 'attachments') > 0`),
              texts(sql`SELECT text FROM task_steers WHERE task_id = ${task} AND instr(text, 'attachments') > 0`),
              texts(sql`SELECT data AS text FROM thread_items WHERE task_id = ${task} AND instr(data, 'attachments') > 0`),
              texts(sql`SELECT data AS text FROM thread_requests WHERE task_id = ${task} AND instr(data, 'attachments') > 0`),
            ],
            { concurrency: 1 },
          ),
        )
      })

      const referenced = Effect.gen(function* () {
        return collect(
          yield* Effect.all(
            [
              texts(sql`SELECT description AS text FROM tasks WHERE instr(description, 'attachments') > 0`),
              texts(sql`SELECT text FROM task_queue WHERE instr(text, 'attachments') > 0`),
              texts(sql`SELECT text FROM task_steers WHERE instr(text, 'attachments') > 0`),
              texts(sql`SELECT data AS text FROM thread_items WHERE instr(data, 'attachments') > 0`),
              texts(sql`SELECT data AS text FROM thread_requests WHERE instr(data, 'attachments') > 0`),
            ],
            { concurrency: 1 },
          ),
        )
      }).pipe(Effect.withSpan("Attachments.referenced"))

      const isDir = (path: string) =>
        fs.stat(path).pipe(
          Effect.map((info) => info.type === "Directory"),
          Effect.orElseSucceed(() => false),
        )
      const removeFolder = (id: string) =>
        fs.remove(dataDir.attachment(id), { recursive: true }).pipe(
          Effect.as(true),
          Effect.catch((e) => Effect.as(Effect.logWarning(`attachments: removing ${id}: ${e.message}`), false)),
        )

      const upload = Effect.fn("Attachments.upload")(function* (given: string, data: string) {
        const b64 = data.trim()
        if (decodedSize(b64) > MAX_BYTES) return yield* new Invalid({ field: "data", reason: `${given} is larger than ${MAX_BYTES / 1024 / 1024} MB` })
        const bytes = yield* Effect.fromResult(decodeStrictBase64(b64))
        const id = AttachmentId.make((yield* random.uuidV4()).replaceAll("-", ""))
        const name = cleanName(given)
        const folder = dataDir.attachment(id)
        const path = `${folder}/${name}`
        yield* fs.makeDirectory(folder, { recursive: true }).pipe(
          Effect.andThen(fs.writeFile(path, bytes)),
          Effect.mapError((e) => new Invalid({ field: "data", reason: `saving ${name}: ${e.message}` })),
        )
        return { id, name, path, size: bytes.length, mime: mime(name) }
      })

      const get = Effect.fn("Attachments.get")(function* (id: string, name: string) {
        if (!/^[0-9A-Fa-f]{32}$/.test(id) || name !== cleanName(name)) return yield* new AttachmentNotFound({ id, file: name })
        const bytes = yield* fs.readFile(`${dataDir.attachment(id)}/${name}`).pipe(Effect.mapError(() => new AttachmentNotFound({ id, file: name })))
        return { name, size: bytes.length, mime: mime(name), data: Base64.encode(bytes) }
      })

      const dirsFor = Effect.fn("Attachments.dirsFor")(function* (task: TaskId, text: string) {
        const ids = new Set([...(yield* ofTask(task)), ...idsIn(text)])
        const dirs = [...ids].map((id) => dataDir.attachment(id))
        return yield* Effect.filter(dirs, isDir, { concurrency: 1 })
      })

      const removeUnreferenced = Effect.fn("Attachments.removeUnreferenced")(function* (ids: ReadonlySet<string>) {
        if (ids.size === 0) return
        const keep = yield* referenced
        for (const id of ids) {
          if (!keep.has(id) && (yield* isDir(dataDir.attachment(id)))) yield* removeFolder(id)
        }
      })

      const prune = Effect.gen(function* () {
        const entries = yield* fs.readDirectory(dataDir.attachments).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
        const cutoff = (yield* Clock.currentTimeMillis) - UNUSED_FOR_MILLIS
        const old = yield* Effect.filter(
          entries,
          (id) =>
            fs.stat(dataDir.attachment(id)).pipe(
              Effect.map((info) => Option.match(info.mtime, { onNone: () => false, onSome: (mtime) => mtime.getTime() < cutoff })),
              Effect.orElseSucceed(() => false),
            ),
          { concurrency: 1 },
        )
        if (old.length === 0) return 0
        const keep = yield* referenced
        let removed = 0
        for (const id of old) {
          if (!keep.has(id) && (yield* removeFolder(id))) removed++
        }
        if (removed > 0) yield* Effect.logInfo(`attachments: removed ${removed} no longer referred to`)
        return removed
      }).pipe(Effect.withSpan("Attachments.prune"))

      return Attachments.of({ upload, get, ofTask, referenced, dirsFor, removeUnreferenced, prune })
    }),
  )

  /** The pruner (docs/plan/06-server.md, Startup step 4): now, then every 6 hours, for as long as the server runs. */
  static readonly pruner = Layer.effectDiscard(
    Effect.gen(function* () {
      const attachments = yield* Attachments
      yield* attachments.prune.pipe(Effect.repeat(Schedule.spaced("6 hours")), Effect.forkScoped)
    }),
  )
}
