// Dictation and voice notes in the composer, with the phone's own speech recognition (expo-speech-recognition): on the
// device where it can be, else the phone's recognition service (Apple's or Google's). Dictation writes what's heard
// into the field as it's heard. A voice note records as well (Android 13 and later, and iOS), and is attached as audio
// with what was heard of it, which is what the agent can read: Claude doesn't listen to audio files.
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent, type ExpoSpeechRecognitionOptions } from "expo-speech-recognition";
import { useEffect, useRef, useState } from "react";

/** What's been heard so far: the finished parts, and the part still being heard. */
export interface Heard {
  committed: string;
  interim: string;
}

export const NOTHING_HEARD: Heard = { committed: "", interim: "" };

const join = (a: string, b: string) => [a.trim(), b.trim()].filter(Boolean).join(" ");

/**
 * `h` after a result. A result that isn't final replaces the part being heard; a final one finishes it. iOS sends each
 * result whole (everything heard since the start) and a final one at the end; Android sends each stretch of speech on
 * its own, ending with a final one, so the finished parts are put together.
 */
export function heard(h: Heard, transcript: string, isFinal: boolean): Heard {
  return isFinal ? { committed: join(h.committed, transcript), interim: "" } : { committed: h.committed, interim: transcript };
}

export const spoken = (h: Heard) => join(h.committed, h.interim);

/** The field's text while dictating: what was typed before, then what's been said. */
export function withSpeech(before: string, said: string): string {
  if (!said) return before;
  if (!before) return said;
  return /\s$/.test(before) ? before + said : `${before} ${said}`;
}

/** The text that goes with a voice note's recording. */
export const voiceNoteText = (transcript: string) => (transcript.trim() ? `Voice note, as the phone heard it: ${transcript.trim()}` : "");

/** A voice note's file name, which the host takes. */
export const voiceNoteName = (uri: string, now = Date.now()) => `voice-note-${now}.${/\.caf$/i.test(uri) ? "caf" : "wav"}`;

/** Voice notes stop on their own after this long, which keeps one well under an attachment's 10 MB. */
export const MAX_NOTE_MS = 4 * 60 * 1000;

export type SpeechMode = "dictate" | "note";

/** The language to hear: the phone's. */
function lang(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
  } catch {
    return "en-US";
  }
}

function options(mode: SpeechMode, onDevice: boolean): ExpoSpeechRecognitionOptions {
  return {
    lang: lang(),
    interimResults: true,
    continuous: true,
    addsPunctuation: true,
    requiresOnDeviceRecognition: onDevice,
    // 16 kHz, 16-bit: about 2 MB a minute (Android records that anyway).
    recordingOptions: mode === "note" ? { persist: true, outputSampleRate: 16000, outputEncoding: "pcmFormatInt16" } : undefined,
  };
}

/** Whose session it is: only the composer that started one acts on its events (a task's thread can be open over the Assistant tab). */
let owner: object | null = null;

/**
 * Dictation and voice notes for one composer. `onText` gets what's been said so far, while dictating; `onNote` gets a
 * finished voice note's recording and what was heard of it.
 */
export function useSpeech({ onText, onNote }: { onText: (said: string) => void; onNote: (uri: string, transcript: string) => void }) {
  const me = useRef({}).current;
  const [mode, setMode] = useState<SpeechMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [, tick] = useState(0);
  const [onDevice, setOnDevice] = useState(false);
  const [transcript, setTranscript] = useState("");
  const st = useRef({ heard: NOTHING_HEARD, uri: null as string | null, mode: null as SpeechMode | null, onDevice: false, retry: false, retried: false, cancelled: false });
  const cb = useRef({ onText, onNote });
  cb.current = { onText, onNote };

  const mine = () => owner === me;
  const finish = () => {
    if (owner === me) owner = null;
    st.current.mode = null;
    setMode(null);
  };

  useSpeechRecognitionEvent("result", (ev) => {
    if (!mine() || !st.current.mode) return;
    st.current.heard = heard(st.current.heard, ev.results[0]?.transcript ?? "", ev.isFinal);
    const said = spoken(st.current.heard);
    setTranscript(said);
    if (st.current.mode === "dictate") cb.current.onText(said);
  });
  useSpeechRecognitionEvent("audioend", (ev) => {
    if (mine() && ev.uri) st.current.uri = ev.uri;
  });
  useSpeechRecognitionEvent("error", (ev) => {
    if (!mine() || ev.error === "aborted") return;
    // The language isn't on the device: hear it with the phone's service instead, once, when this try has ended.
    if (st.current.onDevice && !st.current.retried && (ev.error === "language-not-supported" || ev.error === "service-not-allowed")) {
      st.current.retry = true;
      return;
    }
    if (ev.error === "no-speech" || ev.error === "speech-timeout") setError("Nothing was heard.");
    else setError(ev.message || `Speech recognition failed (${ev.error}).`);
  });
  useSpeechRecognitionEvent("end", () => {
    if (!mine()) return;
    const again = st.current.mode;
    if (st.current.retry && again && !st.current.cancelled) {
      st.current = { ...st.current, retry: false, retried: true, onDevice: false };
      setOnDevice(false);
      try {
        ExpoSpeechRecognitionModule.start(options(again, false));
        return;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
    const { mode: was, uri, cancelled } = st.current;
    finish();
    if (was === "note" && uri && !cancelled) cb.current.onNote(uri, spoken(st.current.heard));
    else if (was === "note" && !cancelled) setError("The voice note couldn't be recorded on this phone.");
  });

  // The elapsed time on the recording bar, and a voice note's limit.
  useEffect(() => {
    if (!mode) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    const limit = mode === "note" ? setTimeout(() => mine() && ExpoSpeechRecognitionModule.stop(), MAX_NOTE_MS) : undefined;
    return () => {
      clearInterval(timer);
      if (limit) clearTimeout(limit);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);
  // Gone mid-session (the screen closed): stop listening.
  useEffect(
    () => () => {
      if (owner === me) {
        st.current.cancelled = true;
        owner = null;
        ExpoSpeechRecognitionModule.abort();
      }
    },
    [me],
  );

  const start = async (next: SpeechMode) => {
    setError(null);
    if (owner) return setError("The microphone is already listening.");
    if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) return setError("Speech recognition isn't available on this phone.");
    if (next === "note" && !ExpoSpeechRecognitionModule.supportsRecording()) return setError("Voice notes need Android 13 or later.");
    const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!perm.granted) return setError("Microphone or speech recognition access is off for Huntaway: allow it in Settings.");
    const local = ExpoSpeechRecognitionModule.supportsOnDeviceRecognition();
    owner = me;
    st.current = { heard: NOTHING_HEARD, uri: null, mode: next, onDevice: local, retry: false, retried: false, cancelled: false };
    setStartedAt(Date.now());
    setTranscript("");
    setOnDevice(local);
    setMode(next);
    try {
      ExpoSpeechRecognitionModule.start(options(next, local));
    } catch (e) {
      finish();
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /** Stops listening: what was heard stays (and a voice note is attached once its file is written). */
  const stop = () => {
    if (mine()) ExpoSpeechRecognitionModule.stop();
  };

  /** Drops a voice note being recorded. */
  const cancel = () => {
    if (!mine()) return;
    st.current.cancelled = true;
    ExpoSpeechRecognitionModule.abort();
    finish();
  };

  return { mode, error, clearError: () => setError(null), transcript, onDevice, elapsed: mode ? Date.now() - startedAt : 0, start, stop, cancel };
}

/** `ms` as m:ss. */
export const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
