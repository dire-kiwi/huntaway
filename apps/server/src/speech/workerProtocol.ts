import { Schema } from "effect"

// What the server and its speech worker (src/speech-worker.ts) say to each other, a JSON value a line. Each request has
// an `id` its answer echoes, so the server takes only the answer to what it asked (never one left by a request it gave
// up on, nor a line native code wrote to stdout).

export const WorkerRequest = Schema.Union([
  /** Transcribe `audio` (base64 of 16 kHz mono 16-bit PCM) with the model in the file `model`. */
  Schema.Struct({ id: Schema.Int, kind: Schema.Literal("transcribe"), model: Schema.String, audio: Schema.String }),
  /**
   * The SHA-256 of the file `path`, read as a stream: a model's download is checked here, so the server never holds
   * the whole of a model in memory at once.
   */
  Schema.Struct({ id: Schema.Int, kind: Schema.Literal("sha256"), path: Schema.String }),
])
export type WorkerRequest = typeof WorkerRequest.Type

/** What it heard (or the file's hash, in hex), or why it couldn't; `id` -1 for a line that wasn't a request. */
export const WorkerAnswer = Schema.Union([
  Schema.Struct({ id: Schema.Int, ok: Schema.Literal(true), text: Schema.String }),
  Schema.Struct({ id: Schema.Int, ok: Schema.Literal(false), error: Schema.String }),
])
export type WorkerAnswer = typeof WorkerAnswer.Type
