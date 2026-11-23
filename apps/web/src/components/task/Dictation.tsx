import { useAtomValue } from "@effect/atom-react"
import { mutate, query } from "@huntaway/client"
import { clsx } from "clsx"
import { Effect, Exit } from "effect"
import { Base64 } from "effect/encoding"
import { Check, Loader2, Mic, X } from "lucide-react"
import { useEffect, useEffectEvent, useRef, useState, type RefObject } from "react"
import { SPEECH_MAX_SECONDS, SPEECH_MIN_SECONDS, SPEECH_SAMPLE_RATE } from "@huntaway/contracts"
import { cannotRecord, insertDictation, startRecording, type Recording } from "../../speech/recorder"
import { useBoard } from "../../state/board"
import { nowMillis, useNow } from "../../state/clock"
import { exitError, runExit, useAction } from "../../state/mutation"
import { navigate } from "../../state/route"
import { after, every } from "../../state/timers"
import { resultValue } from "../ui"

// Dictation (HE-89), as T3 Code's composer has it: the microphone button beside a field, and while it records, a pill
// with the time, the level, cancel and finish. Ctrl+Shift+D (⌘⇧D) in the field starts and finishes it, or held down,
// records until it is let go; Escape cancels. What was said is transcribed by this page's own server (speech.*) and put
// in at the field's caret.

const MAC = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? "")
/** The dictation shortcut, as Settings → Keyboard shortcuts lists it. */
export const DICTATION_KEYS = MAC ? "⌘⇧D" : "Ctrl+Shift+D"
/** A press of the shortcut held longer than this records until it is let go. */
const HOLD_MS = 300

type Phase = "idle" | "starting" | "recording" | "transcribing"

const isShortcut = (e: KeyboardEvent) => (MAC ? e.metaKey : e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "d"

const elapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

/**
 * The microphone button for `field`. `onText(text, caret)` sets the field's text with what was heard put in at its
 * selection, and where the caret goes after it.
 */
export function Dictation({
  field,
  onText,
  className,
}: {
  field: RefObject<HTMLTextAreaElement | null>
  onText: (text: string, caret: number) => void
  className?: string | undefined
}) {
  const host = useBoard((s) => s.localHostId)
  const status = resultValue(useAtomValue(query("speech.status", host ?? "", undefined)))
  const [phase, setPhase] = useState<Phase>("idle")
  const [error, setError] = useState<string | null>(null)
  const [level, setLevel] = useState(0)
  const [startedAt, setStartedAt] = useState(0)
  const [, run] = useAction()
  const recording = useRef<Recording | null>(null)
  // The phase as the microphone's answer and the keys find it, which may come between renders.
  const phaseNow = useRef<Phase>("idle")
  // When the shortcut that started a recording went down, while it is held.
  const pressedAt = useRef<number | null>(null)
  const go = (next: Phase) => {
    phaseNow.current = next
    setPhase(next)
  }

  const cantRecord = cannotRecord()
  const ready = status?.active != null && cantRecord === null && host !== null

  const cancel = () => {
    const r = recording.current
    recording.current = null
    go("idle")
    if (r !== null) void run(r.cancel)
  }

  const finish = () => {
    const r = recording.current
    if (r === null || host === null) return
    recording.current = null
    go("transcribing")
    void run(
      r.finish.pipe(
        // A tap of the button, with nothing said, is nothing to transcribe.
        Effect.flatMap((pcm) =>
          pcm.byteLength < SPEECH_SAMPLE_RATE * SPEECH_MIN_SECONDS * 2
            ? Effect.succeed({ text: "" })
            : mutate("speech.transcribe", host, { audio: Base64.encode(pcm) }),
        ),
        Effect.tap(({ text }) =>
          Effect.sync(() => {
            const el = field.current
            if (el === null) return
            const next = insertDictation(el.value, el.selectionStart, el.selectionEnd, text)
            onText(next.text, next.caret)
            el.focus()
          }),
        ),
      ),
    ).then((exit) => {
      go("idle")
      setError(Exit.isFailure(exit) ? `Couldn't transcribe it: ${exitError(exit) ?? "it stopped"}` : null)
    })
  }

  const start = () => {
    if (!ready || phaseNow.current !== "idle") return
    setError(null)
    go("starting")
    void run(startRecording).then((exit) => {
      if (Exit.isFailure(exit)) {
        go("idle")
        setError(exitError(exit))
        return
      }
      // Cancelled while the browser asked for the microphone.
      if (phaseNow.current !== "starting") {
        void run(exit.value.cancel)
        return
      }
      recording.current = exit.value
      setStartedAt(nowMillis())
      go("recording")
    })
  }

  // The level, a few times a second, and the five-minute limit, while it records.
  const atLimit = useEffectEvent(() => finish())
  useEffect(() => {
    if (phase !== "recording") return undefined
    const stopLevel = every("80 millis", () => setLevel(recording.current?.level() ?? 0))
    const stopLimit = after(`${SPEECH_MAX_SECONDS} seconds`, atLimit)
    return () => {
      stopLevel()
      stopLimit()
      setLevel(0)
    }
  }, [phase])

  // The shortcut and Escape, in the field.
  const keyDown = useEffectEvent((e: KeyboardEvent) => {
    const now = phaseNow.current
    if (e.key === "Escape" && (now === "recording" || now === "starting")) {
      e.preventDefault()
      e.stopPropagation()
      cancel()
      return
    }
    if (!isShortcut(e)) return
    e.preventDefault()
    if (e.repeat) return
    if (now === "idle") {
      pressedAt.current = nowMillis()
      start()
    } else if (now === "recording") finish()
  })
  const keyUp = useEffectEvent((e: KeyboardEvent) => {
    const at = pressedAt.current
    if (at === null || e.key.toLowerCase() !== "d") return
    pressedAt.current = null
    if (nowMillis() - at >= HOLD_MS && phaseNow.current === "recording") finish()
  })
  useEffect(() => {
    const el = field.current
    if (el === null) return undefined
    el.addEventListener("keydown", keyDown)
    el.addEventListener("keyup", keyUp)
    return () => {
      el.removeEventListener("keydown", keyDown)
      el.removeEventListener("keyup", keyUp)
    }
  }, [field])

  // A recording doesn't outlive its composer: one going is cancelled, and one still waiting for the microphone is
  // cancelled when it gets it (`start` cancels a recording that comes once the phase isn't "starting").
  useEffect(
    () => () => {
      phaseNow.current = "idle"
      const r = recording.current
      recording.current = null
      if (r !== null) void runExit(r.cancel)
    },
    [],
  )

  // Nothing where the host can't transcribe, or before it has said whether it can.
  if (status === undefined || status.unsupported !== null || host === null) return null

  if (phase === "recording" || phase === "starting")
    return <RecordingPill startedAt={phase === "recording" ? startedAt : null} level={level} onCancel={cancel} onFinish={finish} />

  const title =
    cantRecord ??
    (status.active == null
      ? "Set up dictation: download a speech model in Settings → Voice input"
      : `Dictate (${DICTATION_KEYS}, or hold it down while you speak)`)
  return (
    <span className={clsx("flex min-w-0 items-center gap-1.5", className)}>
      {error && (
        <span className="min-w-0 truncate text-[11px] text-red-400" title={error}>
          {error}
        </span>
      )}
      <button
        type="button"
        onClick={() => (status.active == null ? navigate({ name: "settings", tab: "voice" }) : start())}
        // Keeps the field's selection, where what is heard goes.
        onMouseDown={(e) => e.preventDefault()}
        disabled={cantRecord !== null || phase === "transcribing"}
        title={phase === "transcribing" ? "Transcribing…" : title}
        aria-label="Dictate"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-faint hover:bg-white/5 hover:text-fg disabled:opacity-50 disabled:hover:bg-transparent narrow:h-9 narrow:w-9"
      >
        {phase === "transcribing" ? <Loader2 size={14} className="animate-spin" /> : <Mic size={14} />}
      </button>
    </span>
  )
}

/** The level's bars, each a share of the level. */
const BARS = [0.6, 1, 0.8, 1, 0.6].map((k, id) => ({ id, k }))

/** While it records: the time, how loud it is, and cancel and finish. Before the microphone is given, the time waits. */
function RecordingPill({ startedAt, level, onCancel, onFinish }: { startedAt: number | null; level: number; onCancel: () => void; onFinish: () => void }) {
  const now = useNow(250)
  return (
    <span
      className="flex h-7 shrink-0 items-center gap-2 rounded-full border border-line-strong bg-raised pr-0.5 pl-2.5 narrow:h-9"
      role="status"
      aria-label="Recording"
    >
      <span className={clsx("h-2 w-2 shrink-0 rounded-full", startedAt === null ? "bg-white/30" : "animate-pulse bg-red-500")} />
      <span className="text-[11px] text-muted tabular-nums">{elapsed(startedAt === null ? 0 : now - startedAt)}</span>
      <span className="flex h-3 w-12 items-center gap-[2px]" aria-hidden>
        {BARS.map(({ id, k }) => (
          <span
            key={id}
            className="w-[3px] rounded-full bg-accent transition-[height] duration-75"
            style={{ height: `${Math.max(15, Math.min(100, level * k * 110))}%` }}
          />
        ))}
      </span>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onCancel}
        title="Cancel (Esc)"
        aria-label="Cancel dictation"
        className="flex h-6 w-6 items-center justify-center rounded-full text-faint hover:bg-white/10 hover:text-fg"
      >
        <X size={13} />
      </button>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onFinish}
        disabled={startedAt === null}
        title={`Finish and transcribe (${DICTATION_KEYS})`}
        aria-label="Finish dictation"
        className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-strong text-white hover:bg-accent disabled:bg-white/10 disabled:text-faint"
      >
        <Check size={13} />
      </button>
    </span>
  )
}
