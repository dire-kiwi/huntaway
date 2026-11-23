// Recording a dictation (HE-89): the microphone through a MediaRecorder, and when it stops, the recording decoded and
// resampled to the 16 kHz mono 16-bit PCM the host's speech engine takes (an OfflineAudioContext does both). T3 Code
// streams its PCM from an AudioWorklet to show what it hears as it goes; a dictation here is transcribed once it ends,
// so the browser's own recorder is enough. The level shown while recording is read from an AnalyserNode.
import { Effect, Schema } from "effect"
import { SPEECH_SAMPLE_RATE } from "@huntaway/contracts"

/** The microphone couldn't be used, or the recording couldn't be read: why, as the composer shows it. */
export class RecordFailed extends Schema.TaggedError<RecordFailed, { readonly brand: unique symbol }>()("RecordFailed", { message: Schema.String }) {}

/** A recording going. */
export interface Recording {
  /** How loud it is now, from 0 to 1. */
  readonly level: () => number
  /** Stop, and give what was recorded as 16 kHz mono 16-bit PCM. */
  readonly finish: Effect.Effect<Uint8Array, RecordFailed>
  /** Stop and keep nothing. */
  readonly cancel: Effect.Effect<void>
}

/** Why this page can't record at all (no microphone API outside a secure context), or null when it can. */
export const cannotRecord = (): string | null => {
  if (typeof MediaRecorder === "undefined" || !globalThis.navigator?.mediaDevices?.getUserMedia)
    return !globalThis.isSecureContext
      ? "The browser only lets a page use the microphone over https or on localhost"
      : "This browser can't record from a microphone"
  return null
}

/** Float samples as 16-bit little-endian PCM. */
export const floatToPcm16 = (samples: Float32Array): Uint8Array => {
  const out = new Uint8Array(samples.length * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0))
    view.setInt16(i * 2, Math.round(s < 0 ? s * 32768 : s * 32767), true)
  }
  return out
}

const failed = (what: string) => (e: unknown) => new RecordFailed({ message: `${what}: ${e instanceof Error ? e.message : String(e)}` })

/** Why the microphone wasn't given, in words. */
const micRefused = (e: unknown) =>
  new RecordFailed({
    message:
      e instanceof DOMException && e.name === "NotAllowedError"
        ? "The browser wasn't allowed to use the microphone"
        : e instanceof DOMException && e.name === "NotFoundError"
          ? "There's no microphone"
          : `The microphone couldn't be used: ${e instanceof Error ? e.message : String(e)}`,
  })

/** The recording's audio, decoded and resampled to 16 kHz mono. */
const toPcm = (blob: Blob, context: AudioContext) =>
  Effect.gen(function* () {
    const bytes = yield* Effect.tryPromise({ try: () => blob.arrayBuffer(), catch: failed("Reading the recording") })
    const decoded = yield* Effect.tryPromise({ try: () => context.decodeAudioData(bytes), catch: failed("Decoding the recording") })
    const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * SPEECH_SAMPLE_RATE)), SPEECH_SAMPLE_RATE)
    const source = offline.createBufferSource()
    source.buffer = decoded
    source.connect(offline.destination)
    source.start()
    const rendered = yield* Effect.tryPromise({ try: () => offline.startRendering(), catch: failed("Resampling the recording") })
    return floatToPcm16(rendered.getChannelData(0))
  })

/** Ask for the microphone and start recording. */
export const startRecording: Effect.Effect<Recording, RecordFailed> = Effect.gen(function* () {
  const why = cannotRecord()
  if (why !== null) return yield* new RecordFailed({ message: why })
  const stream = yield* Effect.tryPromise({
    try: () => navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }),
    catch: micRefused,
  })
  const context = new AudioContext()
  const analyser = context.createAnalyser()
  analyser.fftSize = 1024
  context.createMediaStreamSource(stream).connect(analyser)
  const samples = new Float32Array(analyser.fftSize)
  const recorder = new MediaRecorder(stream)
  const chunks: Array<Blob> = []
  recorder.addEventListener("dataavailable", (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  })
  recorder.start(250)

  const release = Effect.sync(() => {
    for (const track of stream.getTracks()) track.stop()
    void context.close()
  })
  /** The recorder stopped, with everything it recorded handed over. */
  const stopped = Effect.callback<void>((resume) => {
    if (recorder.state === "inactive") return resume(Effect.void)
    recorder.addEventListener("stop", () => resume(Effect.void), { once: true })
    recorder.stop()
  })

  return {
    level: () => {
      analyser.getFloatTimeDomainData(samples)
      let sum = 0
      for (const s of samples) sum += s * s
      // Speech at a microphone is an RMS of 0.02 to 0.3: its square root spreads that over the meter.
      return Math.min(1, Math.sqrt(Math.sqrt(sum / samples.length)) * 1.6)
    },
    finish: stopped.pipe(Effect.andThen(Effect.suspend(() => toPcm(new Blob(chunks, { type: recorder.mimeType }), context))), Effect.ensuring(release)),
    cancel: Effect.ensuring(stopped, release),
  }
})

/** Where a dictation's text goes in a field: at the selection, with a space between it and the words either side. */
export const insertDictation = (text: string, start: number, end: number, heard: string): { readonly text: string; readonly caret: number } => {
  const said = heard.trim()
  if (said === "") return { text, caret: end }
  const before = text.slice(0, start)
  const after = text.slice(end)
  const lead = before === "" || /\s$/.test(before) ? "" : " "
  const trail = after === "" || /^[\s.,;:!?)]/.test(after) ? "" : " "
  const inserted = `${lead}${said}${trail}`
  return { text: `${before}${inserted}${after}`, caret: before.length + lead.length + said.length }
}
