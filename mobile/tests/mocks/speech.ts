// expo-speech-recognition for Jest: the module's calls are recorded, and `emit` sends the events a recognizer would.
// Aborting a session sends its `end` soon after, as the recognizers do.
type Handler = (ev: unknown) => void;
const handlers = new Map<string, Set<Handler>>();

export const ExpoSpeechRecognitionModule = {
  start: jest.fn(),
  stop: jest.fn(),
  abort: jest.fn(() => void Promise.resolve().then(() => emit("end"))),
  isRecognitionAvailable: jest.fn(() => true),
  supportsRecording: jest.fn(() => true),
  supportsOnDeviceRecognition: jest.fn(() => true),
  requestPermissionsAsync: jest.fn(async () => ({ granted: true })),
  addListener: (name: string, fn: Handler) => {
    if (!handlers.has(name)) handlers.set(name, new Set());
    handlers.get(name)!.add(fn);
    return { remove: () => void handlers.get(name)!.delete(fn) };
  },
};

/** Sends a recognizer event to every listener. */
export function emit(name: string, ev: unknown = null) {
  for (const h of handlers.get(name) ?? []) h(ev);
}

/** A result event. */
export const result = (transcript: string, isFinal = false) => ({ isFinal, results: [{ transcript, confidence: 1, segments: [] }] });

/** The module's hook, on the same listeners. */
export function useSpeechRecognitionEvent(name: string, fn: Handler) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { useEffect, useRef } = require("react") as typeof import("react");
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => ExpoSpeechRecognitionModule.addListener(name, (ev) => ref.current(ev)).remove, [name]);
}
