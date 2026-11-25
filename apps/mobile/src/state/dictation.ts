import { useAtomValue } from "@effect/atom-react"
import { Effect } from "effect"
import { Atom } from "effect/reactivity"
import { useFocusEffect } from "expo-router"
import { ExpoSpeechRecognitionModule } from "expo-speech-recognition"
import { useCallback, useEffect, useId, useRef, useState } from "react"
import { Platform } from "react-native"
import { dictated, errorMessage, fallsBack, type Heard, hear, languageOf, SILENCE } from "../logic/dictation"
import { runExit } from "./action"
import { nowMillis } from "./clock"
import { registry } from "./registry"

// Dictation into a text field (HE-99), with the phone's own speech recognition (`expo-speech-recognition`: Android's
// recogniser, iOS's, a browser's on the web build). The phone has one recogniser, so the app has one dictation at a
// time, owned by the field that started it. What is heard goes after what the field held, as it is heard. It listens
// on the phone itself where the phone can, and falls back once to the phone's service (which may send the sound to
// its maker) when the phone has no model for the language. The board's own transcription (`speech.transcribe`, HE-89)
// is not used here.

interface Session {
  /** The field it writes to. */
  readonly owner: string
  /** When it began: which session this is, for what comes back late. */
  readonly since: number
  /** What the field held when it began. */
  readonly base: string
  readonly heard: Heard
  readonly write: (text: string) => void
  /**
   * `asking`: the phone is asked whether the app may listen. `starting`: the recogniser is asked for. `listening`.
   * `stopping`: told to end, its last words still to come. `dropped`: given up on; what it says is ignored, and no
   * other begins until it has ended (its end would look like the next one's).
   */
  readonly phase: "asking" | "starting" | "listening" | "stopping" | "dropped"
  /** It listens on the phone itself. */
  readonly onDevice: boolean
  /** The phone itself couldn't: once it has ended, the phone's service is tried. */
  readonly again: boolean
}

const sessionAtom = Atom.make<Session | null>(null).pipe(Atom.keepAlive)
const errorOf = Atom.family((_owner: string) => Atom.make<string | null>(null).pipe(Atom.keepAlive))

/** How long a recogniser told to end has to say so, before it is taken as ended. */
const ENDS_WITHIN = "3 seconds"

/** Whether the phone can recognise speech at all; a field shows no microphone when it can't. */
export const canDictate = (): boolean => {
  try {
    return ExpoSpeechRecognitionModule.isRecognitionAvailable()
  } catch {
    return false
  }
}

const onDevice = (): boolean => {
  try {
    return ExpoSpeechRecognitionModule.supportsOnDeviceRecognition()
  } catch {
    return false
  }
}

/** Android before 13 hears one stretch and ends; the rest go on until told to stop. */
const CONTINUOUS = !(Platform.OS === "android" && typeof Platform.Version === "number" && Platform.Version < 33)

const fail = (session: Session, message: string): void => {
  registry.set(errorOf(session.owner), message)
  registry.set(sessionAtom, null)
}

function begin(session: Session): void {
  try {
    ExpoSpeechRecognitionModule.start({
      lang: languageOf(Intl.DateTimeFormat().resolvedOptions().locale),
      interimResults: true,
      maxAlternatives: 1,
      continuous: CONTINUOUS,
      requiresOnDeviceRecognition: session.onDevice,
      addsPunctuation: true,
      iosTaskHint: "dictation",
    })
  } catch {
    fail(session, "The phone's speech recognition couldn't start.")
  }
}

/** A session told to end that never says it has: taken as ended, so the microphone isn't held for good. */
function endsSoon(since: number): void {
  runExit(Effect.sleep(ENDS_WITHIN), () => {
    const session = registry.get(sessionAtom)
    if (session !== null && session.since === since && (session.phase === "stopping" || session.phase === "dropped")) registry.set(sessionAtom, null)
  })
}

let subscribed = false

/** The recogniser's events, heard once for the app: they are the one session's, whichever field owns it. */
function subscribe(): void {
  if (subscribed) return
  subscribed = true
  ExpoSpeechRecognitionModule.addListener("start", () => {
    const session = registry.get(sessionAtom)
    if (session?.phase === "starting") registry.set(sessionAtom, { ...session, phase: "listening" })
  })
  ExpoSpeechRecognitionModule.addListener("result", (event) => {
    const session = registry.get(sessionAtom)
    const transcript = event.results[0]?.transcript
    if (session === null || session.phase === "dropped" || session.phase === "asking" || transcript === undefined) return
    const heard = hear(session.heard, transcript, event.isFinal)
    registry.set(sessionAtom, { ...session, heard })
    session.write(dictated(session.base, heard))
  })
  ExpoSpeechRecognitionModule.addListener("error", (event) => {
    const session = registry.get(sessionAtom)
    if (session === null || session.phase === "dropped" || session.phase === "asking") return
    if (session.onDevice && !session.again && fallsBack(event.error)) return registry.set(sessionAtom, { ...session, again: true })
    registry.set(errorOf(session.owner), errorMessage(event.error, event.message))
  })
  ExpoSpeechRecognitionModule.addListener("end", () => {
    const session = registry.get(sessionAtom)
    if (session === null || session.phase === "asking") return
    if (!session.again || session.phase === "dropped" || session.phase === "stopping") return registry.set(sessionAtom, null)
    // What was heard so far stays; the phone's service hears the rest.
    const next: Session = { ...session, phase: "starting", onDevice: false, again: false, heard: hear(session.heard, session.heard.saying, true) }
    registry.set(sessionAtom, next)
    begin(next)
  })
}

function start(owner: string, base: string, write: (text: string) => void): void {
  if (registry.get(sessionAtom) !== null) return registry.set(errorOf(owner), "The microphone is still busy: try again in a moment.")
  registry.set(errorOf(owner), null)
  const since = nowMillis()
  registry.set(sessionAtom, { owner, since, base, heard: SILENCE, write, phase: "asking", onDevice: false, again: false })
  subscribe()
  const asked = (granted: boolean): void => {
    const session = registry.get(sessionAtom)
    // Given up on while the phone asked.
    if (session === null || session.since !== since || session.phase !== "asking") return
    if (!granted) return fail(session, "Huntaway may not use the microphone: allow it in the phone's settings.")
    const next: Session = { ...session, phase: "starting", onDevice: onDevice() }
    registry.set(sessionAtom, next)
    begin(next)
  }
  void ExpoSpeechRecognitionModule.requestPermissionsAsync().then(
    (permission) => asked(permission.granted),
    () => asked(false),
  )
}

/** Ends `owner`'s dictation, keeping the words still to come. */
function stop(session: Session): void {
  if (session.phase === "asking") return registry.set(sessionAtom, null)
  if (session.phase !== "starting" && session.phase !== "listening") return
  registry.set(sessionAtom, { ...session, phase: "stopping" })
  ExpoSpeechRecognitionModule.stop()
  endsSoon(session.since)
}

/** Gives up `owner`'s dictation: the field's text stays as it is, whatever the recogniser still says. */
function drop(owner: string): void {
  const session = registry.get(sessionAtom)
  if (session === null || session.owner !== owner || session.phase === "dropped") return
  if (session.phase === "asking") return registry.set(sessionAtom, null)
  registry.set(sessionAtom, { ...session, phase: "dropped" })
  ExpoSpeechRecognitionModule.abort()
  endsSoon(session.since)
}

/** A field's dictation, as its microphone button shows it. */
export interface Dictation {
  /** The phone can recognise speech: the field has a microphone. */
  readonly available: boolean
  /** It is this field's, and going: `starting` until the phone listens, `stopping` while its last words come. */
  readonly phase: "starting" | "listening" | "stopping" | null
  /** Why it failed last. */
  readonly error: string | null
  /** Starts dictating after `text` (what the field holds), or stops. */
  readonly toggle: (text: string) => void
  /** The field's text was changed to `text`: by the person, unless it is what the dictation wrote, and then it ends. */
  readonly edited: (text: string) => void
  /** Ends it as it is: the field's text went somewhere (a message was sent). */
  readonly drop: () => void
}

/**
 * Dictation for one text field: `onText` gets the field's whole text as it is heard. It ends when the screen is left
 * or the field goes away: nobody is there to see what it writes.
 */
export function useDictation(onText: (text: string) => void): Dictation {
  const owner = useId()
  const session = useAtomValue(sessionAtom)
  const error = useAtomValue(errorOf(owner))
  // Asked of the phone once for the field, not at each keystroke.
  const [available] = useState(canDictate)
  const write = useRef(onText)
  useEffect(() => {
    write.current = onText
  })
  useFocusEffect(useCallback(() => () => drop(owner), [owner]))
  const mine = session !== null && session.owner === owner && session.phase !== "dropped" ? session : null
  return {
    available,
    phase: mine === null ? null : mine.phase === "asking" ? "starting" : mine.phase === "dropped" ? null : mine.phase,
    error,
    toggle: (text) => {
      const now = registry.get(sessionAtom)
      if (now !== null && now.owner === owner) return stop(now)
      start(owner, text, (heard) => write.current(heard))
    },
    edited: (text) => {
      const now = registry.get(sessionAtom)
      if (now !== null && now.owner === owner && text !== dictated(now.base, now.heard)) drop(owner)
    },
    drop: () => drop(owner),
  }
}
