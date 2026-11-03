// expo-speech-recognition for Jest: the module's calls are recorded, and `emit` sends the events a recognizer would.
import { useEffect, useRef } from "react";

type Handler = (ev: unknown) => void;
const handlers = new Map<string, Set<Handler>>();

export const ExpoSpeechRecognitionModule = {
  start: jest.fn(),
  stop: jest.fn(),
  abort: jest.fn(),
  isRecognitionAvailable: jest.fn(() => true),
  supportsRecording: jest.fn(() => true),
  supportsOnDeviceRecognition: jest.fn(() => true),
  requestPermissionsAsync: jest.fn(async () => ({ granted: true })),
};

export function useSpeechRecognitionEvent(name: string, fn: Handler) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const h: Handler = (ev) => ref.current(ev);
    if (!handlers.has(name)) handlers.set(name, new Set());
    handlers.get(name)!.add(h);
    return () => void handlers.get(name)!.delete(h);
  }, [name]);
}

/** Sends a recognizer event to every listener. */
export function emit(name: string, ev: unknown = null) {
  for (const h of handlers.get(name) ?? []) h(ev);
}

/** A result event. */
export const result = (transcript: string, isFinal = false) => ({ isFinal, results: [{ transcript, confidence: 1, segments: [] }] });
