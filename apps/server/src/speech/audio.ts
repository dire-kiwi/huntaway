import { SPEECH_MAX_SECONDS, SPEECH_MIN_SECONDS, SPEECH_SAMPLE_RATE } from "@huntaway/contracts"

// The audio of a dictation (HE-89), as plain functions: the browser's 16-bit PCM as the engine's float samples, and a
// long recording cut at its pauses into pieces a model takes at once (T3 Code cuts at what Silero hears as silence;
// this cuts at the quietest stretch, which is enough for one speaker at a microphone).

/** The most bytes a dictation's PCM may be: five minutes of 16-bit samples. */
export const MAX_PCM_BYTES = SPEECH_SAMPLE_RATE * SPEECH_MAX_SECONDS * 2

/** The fewest bytes: `SPEECH_MIN_SECONDS` of 16-bit samples. */
export const MIN_PCM_BYTES = Math.ceil(SPEECH_SAMPLE_RATE * SPEECH_MIN_SECONDS) * 2

/** Why audio was refused, or null when it is 16-bit PCM of a usable length. */
export const pcmProblem = (bytes: Uint8Array): string | null => {
  if (bytes.byteLength === 0) return "the recording is empty"
  if (bytes.byteLength % 2 !== 0) return "the recording isn't 16-bit PCM"
  if (bytes.byteLength < MIN_PCM_BYTES) return "the recording is too short"
  if (bytes.byteLength > MAX_PCM_BYTES) return `the recording is longer than ${SPEECH_MAX_SECONDS / 60} minutes`
  return null
}

/** 16-bit little-endian PCM as samples between -1 and 1. */
export const pcmToFloat = (bytes: Uint8Array): Float32Array => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Float32Array(Math.floor(bytes.byteLength / 2))
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768
  return out
}

/** The samples' frames the quietest stretch is looked for in: 20 ms. */
const FRAME = SPEECH_SAMPLE_RATE / 50

/**
 * `pcm` in pieces of at most `max` samples, each cut at the quietest 20 ms in the last 40% of the piece (a pause
 * between words, as a rule), so no word is split where the speaker paused for one.
 */
export const splitAtPauses = (pcm: Float32Array, max: number): ReadonlyArray<Float32Array> => {
  const pieces: Array<Float32Array> = []
  let start = 0
  while (pcm.length - start > max) {
    const from = start + Math.floor(max * 0.6)
    const to = start + max - FRAME
    let cut = start + max
    let quietest = Number.POSITIVE_INFINITY
    for (let at = from; at <= to; at += FRAME) {
      let energy = 0
      for (let i = at; i < at + FRAME; i++) energy += (pcm[i] ?? 0) ** 2
      if (energy < quietest) {
        quietest = energy
        cut = at + FRAME / 2
      }
    }
    pieces.push(pcm.subarray(start, cut))
    start = cut
  }
  if (start < pcm.length) pieces.push(pcm.subarray(start))
  return pieces
}

/** The pieces' texts as one: trimmed, with one space between. */
export const joinTexts = (texts: ReadonlyArray<string>): string =>
  texts
    .map((t) => t.trim())
    .filter((t) => t !== "")
    .join(" ")
