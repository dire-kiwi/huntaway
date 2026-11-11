/**
 * The page's keyboard shortcuts that can be changed (HA-396), and the keys picked for them in Settings → Keyboard
 * shortcuts: kept in this browser, as the notification settings are. Each is one key pressed without Ctrl, Alt or Cmd,
 * outside a field (the handlers check that themselves); the ones that can't be changed are listed in `FIXED_SHORTCUTS`.
 */
import { useSyncExternalStore } from "react"
import { parseJson, toJson } from "./components/ui/json"

export const SHORTCUTS = [
  { id: "profile.next", group: "Anywhere", label: "Next profile", key: "p" },
  { id: "profile.previous", group: "Anywhere", label: "Previous profile", key: "P" },
  { id: "assistant", group: "Anywhere", label: "Open the profile's assistant", key: "a" },
  { id: "search", group: "Board", label: "Go to the search field", key: "/" },
  { id: "triage.next", group: "Triage view", label: "Next task", key: "j" },
  { id: "triage.previous", group: "Triage view", label: "Previous task", key: "k" },
  { id: "compare.next", group: "Compare view, one at a time", label: "Next task", key: "]" },
  { id: "compare.previous", group: "Compare view, one at a time", label: "Previous task", key: "[" },
] as const

export type ShortcutId = (typeof SHORTCUTS)[number]["id"]
export type ShortcutKeys = Record<ShortcutId, string>

/** The keys that are what they are: for the settings page's list. */
export const FIXED_SHORTCUTS: { group: string; label: string; keys: string }[] = [
  { group: "Anywhere", label: "Close the open dialog, menu, panel or task", keys: "Esc" },
  { group: "Anywhere", label: "Submit a dialog or an editor", keys: /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? "") ? "⌘↵" : "Ctrl+Enter" },
  { group: "Anywhere", label: "Pick an answer on the latest question card", keys: "1–9" },
  { group: "Triage view", label: "Open the task's thread", keys: "Enter" },
  { group: "Compare view, one at a time", label: "Next or previous task", keys: "→ ←" },
  { group: "Compare view, one at a time", label: "Go to a task", keys: "1–9" },
  { group: "Changes tab", label: "Its own keys: press ? there for the list", keys: "?" },
]

export const DEFAULT_SHORTCUTS: ShortcutKeys = {
  "profile.next": "p",
  "profile.previous": "P",
  assistant: "a",
  search: "/",
  "triage.next": "j",
  "triage.previous": "k",
  "compare.next": "]",
  "compare.previous": "[",
} satisfies { [S in (typeof SHORTCUTS)[number] as S["id"]]: S["key"] }

/** A key a shortcut can have: one printable character (not a space), as `KeyboardEvent.key` gives it. */
export const isShortcutKey = (key: unknown): key is string => typeof key === "string" && Array.from(key).length === 1 && key.trim() !== ""

/** Where a shortcut's key is live: the compare view is over the page, and the search field is in every view of a board, the triage view too. */
const place = (id: ShortcutId) => (id.startsWith("compare.") ? "compare" : id.startsWith("profile.") || id === "assistant" ? "anywhere" : "board")
/** Whether two shortcuts are live at once: one that works anywhere is, with every other. */
const together = (a: ShortcutId, b: ShortcutId) => place(a) === place(b) || place(a) === "anywhere" || place(b) === "anywhere"

/** What already has `key` where shortcut `id` works (another shortcut that's live there, or a fixed key), if anything. */
export function shortcutTaken(keys: ShortcutKeys, id: ShortcutId, key: string): string | null {
  // The digits go to a task in the compare view, and answer a question card anywhere else (Questions.tsx).
  if (/^[1-9]$/.test(key)) return place(id) === "compare" ? "Go to a task" : "Pick an answer on the latest question card"
  const other = SHORTCUTS.find((s) => s.id !== id && together(s.id, id) && keys[s.id] === key)
  return other ? (other.group === SHORTCUTS.find((s) => s.id === id)?.group ? other.label : `${other.label} (${other.group})`) : null
}

const KEY = "ia.shortcuts"

/** The keys when this browser has no storage, for this page only. */
let unsaved: string | null = null

function readSaved(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return unsaved
  }
}

function parseKeys(raw: string | null): ShortcutKeys {
  const keys = { ...DEFAULT_SHORTCUTS }
  try {
    const saved = parseJson(raw ?? "{}")
    if (typeof saved === "object" && saved !== null)
      for (const s of SHORTCUTS) {
        const key: unknown = Reflect.get(saved, s.id)
        if (isShortcutKey(key)) keys[s.id] = key
      }
  } catch {
    // Kept keys that can't be read: the defaults.
  }
  // Saved keys that clash (edited by hand, or with a shortcut added since) go back to their defaults, and the rest stay.
  // A default one of those goes back to may be another's saved key, which then goes back too.
  for (;;) {
    const clashing = SHORTCUTS.filter((s) => keys[s.id] !== s.key && shortcutTaken(keys, s.id, keys[s.id]))
    if (!clashing.length) return keys
    for (const s of clashing) keys[s.id] = s.key
  }
}

let cached: { raw: string | null; keys: ShortcutKeys } | null = null

/** Each shortcut's key: the one picked in this browser, or its default. The same object while they don't change. */
export function shortcutKeys(): ShortcutKeys {
  const raw = readSaved()
  if (!cached || cached.raw !== raw) cached = { raw, keys: parseKeys(raw) }
  return cached.keys
}

const listeners = new Set<() => void>()

/** Gives shortcut `id` the key `key`, or its default back with null. Only the changed ones are kept. */
export function saveShortcut(id: ShortcutId, key: string | null) {
  const keys = { ...shortcutKeys(), [id]: key ?? DEFAULT_SHORTCUTS[id] }
  const raw = toJson(Object.fromEntries(SHORTCUTS.filter((s) => keys[s.id] !== s.key).map((s) => [s.id, keys[s.id]])))
  try {
    localStorage.setItem(KEY, raw)
  } catch {
    unsaved = raw
  }
  listeners.forEach((l) => l())
}

function onShortcuts(cb: () => void) {
  const storage = (e: StorageEvent) => e.key === KEY && cb()
  listeners.add(cb)
  window.addEventListener("storage", storage)
  return () => {
    listeners.delete(cb)
    window.removeEventListener("storage", storage)
  }
}

/** The keys, for a component that shows them. */
export const useShortcutKeys = () => useSyncExternalStore(onShortcuts, shortcutKeys)

/** Whether a key press is shortcut `id`'s key. The caller checks the modifiers and where it was pressed. */
export const isShortcut = (e: { key: string }, id: ShortcutId) => e.key === shortcutKeys()[id]

/** Whether a key press is meant for the page rather than a field being typed in, or a dialog or menu. */
export const forPage = (e: KeyboardEvent) =>
  !e.ctrlKey &&
  !e.metaKey &&
  !e.altKey &&
  !(e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable]")) &&
  !document.querySelector("[data-modal], [data-task-modal]")
