import { Schema } from "effect"

// What the server and its speech worker (src/speech-worker.ts) say to each other, a JSON value a line.

export const WorkerRequest = Schema.Union([
  /** Transcribe `audio` (base64 of 16 kHz mono 16-bit PCM) with the model in the file `model`. */
  Schema.Struct({ kind: Schema.Literal("transcribe"), model: Schema.String, audio: Schema.String }),
  /**
   * The SHA-256 of the file `path`, read as a stream: a model's download is checked here, so the server never holds
   * the whole of a model in memory at once.
   */
  Schema.Struct({ kind: Schema.Literal("sha256"), path: Schema.String }),
])
export type WorkerRequest = typeof WorkerRequest.Type

/** What it heard (or the file's hash, in hex), or why it couldn't. */
export const WorkerAnswer = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), text: Schema.String }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
])
export type WorkerAnswer = typeof WorkerAnswer.Type
