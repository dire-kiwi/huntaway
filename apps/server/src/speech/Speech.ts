import { Context, Effect, FiberHandle, FileSystem, Layer, Ref, Stream } from "effect"
import { Base64 } from "effect/encoding"
import { HttpClient, HttpClientRequest } from "effect/http"
import { Conflict, Invalid, NotFound, Unavailable } from "@huntaway/contracts"
import type { SpeechDownload, SpeechStatus, SpeechTranscript } from "@huntaway/contracts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { SettingsRepo } from "../settings/SettingsRepo.ts"
import { pcmProblem } from "./audio.ts"
import { CATALOG, modelUrl, type CatalogModel } from "./catalog.ts"
import { SpeechEngine } from "./SpeechEngine.ts"

// Dictation on this host (HE-89, docs/plan/06-server.md, Speech): the models it can download (catalog.ts), which of
// them it has under `<data>/speech/models/`, the one it uses (the `speech_model` setting), and transcribing a
// recording with it (SpeechEngine). A model is downloaded in the background into a `.part` file beside where it goes,
// its size and SHA-256 checked, and renamed into place, so a file under its own name is always a whole model.

/** The `settings` key of the model chosen. */
const SETTING = "speech_model"

export interface SpeechShape {
  readonly status: Effect.Effect<SpeechStatus>
  /** Start downloading `model` in the background; it is used once it is in (`speech.download`). */
  readonly download: (model: string) => Effect.Effect<SpeechStatus, NotFound | Conflict | Unavailable>
  /** Stop the download going, and remove what it had. */
  readonly cancel: Effect.Effect<SpeechStatus>
  readonly remove: (model: string) => Effect.Effect<SpeechStatus, NotFound>
  readonly select: (model: string) => Effect.Effect<SpeechStatus, NotFound>
  /** What the model in use hears in `audio` (base64 of 16 kHz mono 16-bit PCM). */
  readonly transcribe: (audio: string) => Effect.Effect<SpeechTranscript, Invalid | Unavailable>
  /** Waits for the download going, if there is one, to end. */
  readonly settled: Effect.Effect<void>
}

const unavailable = (reason: string) => new Unavailable({ what: "dictation", reason })

const findIn = (catalog: ReadonlyArray<CatalogModel>, id: string) => {
  const m = catalog.find((c) => c.id === id)
  return m === undefined ? Effect.fail(new NotFound({ what: "speech model", id })) : Effect.succeed(m)
}

export class Speech extends Context.Service<Speech, SpeechShape>()("huntaway-server/speech/Speech") {
  /** Over `catalog` (tests give one of their own). */
  static readonly make = (catalog: ReadonlyArray<CatalogModel>) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig
      const fs = yield* FileSystem.FileSystem
      const client = yield* HttpClient.HttpClient
      const settings = yield* SettingsRepo
      const engine = yield* SpeechEngine
      const dir = `${config.dataDir}/speech/models`
      const downloading = yield* Ref.make<SpeechDownload | null>(null)
      const failed = yield* Ref.make<{ readonly model: string; readonly reason: string } | null>(null)
      const fiber = yield* FiberHandle.make<void, never>()

      const fileOf = (m: CatalogModel) => `${dir}/${m.filename}`
      const partOf = (m: CatalogModel) => `${fileOf(m)}.part`
      const isInstalled = (m: CatalogModel) => fs.exists(fileOf(m)).pipe(Effect.orElseSucceed(() => false))

      /** The model in use: the one chosen if it is installed, else the first installed in the catalog's order. */
      const active = Effect.gen(function* () {
        const chosen = yield* settings.get(SETTING)
        const installed = yield* Effect.filter(catalog, isInstalled, { concurrency: 1 })
        return installed.find((m) => m.id === chosen) ?? installed[0] ?? null
      })

      const status: Effect.Effect<SpeechStatus> = Effect.gen(function* () {
        const models = yield* Effect.forEach(
          catalog,
          (m) =>
            Effect.map(isInstalled(m), (installed) => ({
              id: m.id,
              name: m.name,
              description: m.description,
              size: m.size,
              languages: m.languages,
              recommended: m.recommended,
              installed,
            })),
          { concurrency: 1 },
        )
        return {
          unsupported: engine.unsupported,
          models,
          active: (yield* active)?.id ?? null,
          downloading: yield* Ref.get(downloading),
          failed: yield* Ref.get(failed),
        }
      })

      const fetchModel = (m: CatalogModel) =>
        Effect.gen(function* () {
          const part = partOf(m)
          const response = yield* client.execute(HttpClientRequest.get(modelUrl(m))).pipe(Effect.mapError((e) => `downloading it: ${e.message}`))
          if (response.status < 200 || response.status >= 300) return yield* Effect.fail(`downloading it: HTTP ${response.status}`)
          let received = 0
          yield* response.stream.pipe(
            Stream.mapError((e) => `downloading it: ${e.message}`),
            Stream.tap((chunk) => {
              received += chunk.byteLength
              return received > m.size
                ? Effect.fail(`the download is bigger than the model's ${m.size} bytes`)
                : Ref.set(downloading, { model: m.id, phase: "downloading" as const, received, total: m.size })
            }),
            Stream.run(fs.sink(part)),
            Effect.mapError((e) => (typeof e === "string" ? e : `saving it: ${e.message}`)),
          )
          if (received !== m.size) return yield* Effect.fail(`downloaded ${received} bytes of it, not ${m.size}`)
          yield* Ref.set(downloading, { model: m.id, phase: "verifying" as const, received, total: m.size })
          const sum = yield* engine.sha256(part).pipe(Effect.mapError((e) => `checking it: ${e.reason}`))
          if (sum !== m.sha256) return yield* Effect.fail(`its SHA-256 is ${sum}, not ${m.sha256}`)
          yield* fs.rename(part, fileOf(m)).pipe(Effect.mapError((e) => `putting it in place: ${e.message}`))
          return yield* settings.set(SETTING, m.id)
        }).pipe(
          Effect.catch((reason) =>
            Effect.andThen(Ref.set(failed, { model: m.id, reason }), Effect.logWarning(`downloading the speech model ${m.id} failed: ${reason}`)),
          ),
          Effect.ensuring(Effect.andThen(fs.remove(partOf(m), { force: true }).pipe(Effect.ignore), Ref.set(downloading, null))),
        )

      const download = Effect.fn("Speech.download")(function* (id: string) {
        const m = yield* findIn(catalog, id)
        if (engine.unsupported !== null) return yield* unavailable(engine.unsupported)
        if (yield* isInstalled(m)) {
          yield* settings.set(SETTING, m.id)
          return yield* status
        }
        // One download at a time, claimed at once so two clicks can't both start one.
        const fresh: SpeechDownload = { model: m.id, phase: "downloading", received: 0, total: m.size }
        const going = yield* Ref.modify(downloading, (d): readonly [SpeechDownload | null, SpeechDownload] => (d === null ? [null, fresh] : [d, d]))
        if (going !== null) return yield* new Conflict({ reason: "already_running", detail: `${going.model} is downloading` })
        yield* fs.makeDirectory(dir, { recursive: true }).pipe(
          Effect.mapError((e) => unavailable(`making ${dir}: ${e.message}`)),
          Effect.tapError(() => Ref.set(downloading, null)),
        )
        yield* Ref.set(failed, null)
        yield* FiberHandle.run(fiber, fetchModel(m))
        return yield* status
      })

      const cancel = Effect.gen(function* () {
        yield* FiberHandle.clear(fiber)
        return yield* status
      }).pipe(Effect.withSpan("Speech.cancel"))

      const remove = Effect.fn("Speech.remove")(function* (id: string) {
        const m = yield* findIn(catalog, id)
        yield* fs.remove(fileOf(m), { force: true }).pipe(Effect.ignore)
        return yield* status
      })

      const select = Effect.fn("Speech.select")(function* (id: string) {
        const m = yield* findIn(catalog, id)
        if (!(yield* isInstalled(m))) return yield* new NotFound({ what: "installed speech model", id })
        yield* settings.set(SETTING, m.id)
        return yield* status
      })

      const transcribe = Effect.fn("Speech.transcribe")(function* (audio: string) {
        if (engine.unsupported !== null) return yield* unavailable(engine.unsupported)
        const bytes = Base64.decode(audio)
        if (bytes._tag === "Failure") return yield* new Invalid({ field: "audio", reason: "the audio isn't base64" })
        const problem = pcmProblem(bytes.success)
        if (problem !== null) return yield* new Invalid({ field: "audio", reason: problem })
        const m = yield* active
        if (m === null) return yield* unavailable("no speech model is installed: download one in Settings → Voice input")
        const text = yield* engine.transcribe(fileOf(m), audio).pipe(Effect.mapError((e) => unavailable(e.reason)))
        return { text: text.trim() }
      })

      return Speech.of({ status, download, cancel, remove, select, transcribe, settled: FiberHandle.awaitEmpty(fiber) })
    })

  static readonly layer = Layer.effect(Speech, Speech.make(CATALOG))
}
