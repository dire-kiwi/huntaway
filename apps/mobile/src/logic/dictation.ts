// Dictation's logic (HE-99), apart from the phone's recogniser (state/dictation.ts): what it has heard put after what
// was typed, and what its errors mean to the person speaking.

/**
 * What a dictation has heard so far. A recogniser hears in stretches: it keeps changing its mind about the one being
 * said, then is done with it and starts the next.
 */
export interface Heard {
  /** The stretches it is done with. */
  readonly said: string
  /** The one being said, as it hears it now. */
  readonly saying: string
}

export const SILENCE: Heard = { said: "", saying: "" }

/** `more` after `before`, a space between them unless `before` ends in one (or is empty). */
const after = (before: string, more: string): string => {
  const text = more.trim()
  if (text === "") return before
  return before === "" || /\s$/.test(before) ? `${before}${text}` : `${before} ${text}`
}

/** `heard` with what the recogniser said next: `final` when it is done with the stretch. */
export const hear = (heard: Heard, transcript: string, final: boolean): Heard =>
  final ? { said: after(heard.said, transcript), saying: "" } : { said: heard.said, saying: transcript.trim() }

/** The field's text: what was in it when the dictation began, then what was heard. */
export const dictated = (base: string, heard: Heard): string => after(after(base, heard.said), heard.saying)

/**
 * The recogniser on the phone can't do it (it has no model for the language, or isn't allowed): the phone's service
 * may.
 */
export const fallsBack = (code: string): boolean => code === "language-not-supported" || code === "service-not-allowed"

const MESSAGES: Readonly<Record<string, string>> = {
  "not-allowed": "Huntaway may not use the microphone: allow it in the phone's settings.",
  "service-not-allowed": "The phone's speech recognition is turned off or missing.",
  "language-not-supported": "The phone's speech recognition doesn't have this phone's language.",
  "audio-capture": "The microphone couldn't be used.",
  network: "The phone's speech recognition couldn't reach its service.",
  busy: "The phone's speech recognition is busy: try again in a moment.",
  "too-many-requests": "The phone's speech recognition is busy: try again in a moment.",
  interrupted: "Something else took the microphone.",
}

/** Why a dictation ended, to show; null when it is no failure (it was stopped, or nothing was said). */
export const errorMessage = (code: string, message: string): string | null => {
  if (code === "aborted" || code === "no-speech" || code === "speech-timeout") return null
  return MESSAGES[code] ?? (message.trim() === "" ? "The phone's speech recognition failed." : message.trim())
}

/** The language to listen for, from the phone's locale ("en_NZ" as "en-NZ"); American English when it has none. */
export const languageOf = (locale: string | undefined): string => {
  const tag = (locale ?? "").trim().replaceAll("_", "-")
  return /^[a-z]{2,3}(-[a-z0-9]+)*$/i.test(tag) ? tag : "en-US"
}
