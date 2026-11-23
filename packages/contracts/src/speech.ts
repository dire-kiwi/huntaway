import { Schema } from "effect"

// HE-89: dictation, as T3 Code does it. The browser records the microphone as 16 kHz mono PCM and sends it to its own
// server, which transcribes it on this machine with a speech model it downloaded (transcribe.cpp's GGUF models from
// Hugging Face), in a worker process of its own. Nothing leaves the host but the model's download.

/** The audio a dictation sends: 16 kHz mono, 16-bit little-endian PCM. */
export const SPEECH_SAMPLE_RATE = 16_000
/** The longest dictation: five minutes, about 9.6 MB of PCM (12.8 MB as base64, under the 16 MiB a request may be). */
export const SPEECH_MAX_SECONDS = 300
/** The shortest: less than this is a tap of the button, which the engine can't take (it fails on a few samples). */
export const SPEECH_MIN_SECONDS = 0.3

/** A speech model this host can download, and whether it has. */
export const SpeechModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  /** The download's size in bytes. */
  size: Schema.Int,
  /** The languages it transcribes, as ISO 639-1 codes. */
  languages: Schema.Array(Schema.String),
  recommended: Schema.Boolean,
  installed: Schema.Boolean,
})
export interface SpeechModel extends Schema.Schema.Type<typeof SpeechModel> {}

/** A model being downloaded: bytes so far, of `total`, then its checksum. */
export const SpeechDownload = Schema.Struct({
  model: Schema.String,
  phase: Schema.Literals(["downloading", "verifying"]),
  received: Schema.Int,
  total: Schema.Int,
})
export interface SpeechDownload extends Schema.Schema.Type<typeof SpeechDownload> {}

/** Dictation on this host: whether it can, its models, the one it uses, and a download going or failed. */
export const SpeechStatus = Schema.Struct({
  /** Null when this host can transcribe; else why not (no build of the engine for its platform, say). */
  unsupported: Schema.NullOr(Schema.String),
  models: Schema.Array(SpeechModel),
  /** The model dictation uses: the one chosen, if it is installed, else the first installed; null with none. */
  active: Schema.NullOr(Schema.String),
  downloading: Schema.NullOr(SpeechDownload),
  /** The last download that failed, and why; cleared by the next. */
  failed: Schema.NullOr(Schema.Struct({ model: Schema.String, reason: Schema.String })),
})
export interface SpeechStatus extends Schema.Schema.Type<typeof SpeechStatus> {}

/** What a dictation heard. */
export const SpeechTranscript = Schema.Struct({ text: Schema.String })
export interface SpeechTranscript extends Schema.Schema.Type<typeof SpeechTranscript> {}
