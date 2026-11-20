// Keys as CDP's `Input.dispatchKeyEvent` wants them (HE-62): the agent names a key the way Playwright does ("Enter",
// "Control+a", "Shift+Tab"), and a viewer sends the DOM's own `key`/`code`. Modifiers are CDP's bit field.

const SHIFT = 8
export const MODIFIERS: Readonly<Record<string, number>> = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Command: 4, Cmd: 4, Shift: SHIFT }

interface KeyDef {
  readonly key: string
  readonly code: string
  readonly keyCode: number
  readonly text?: string
}

const NAMED: Readonly<Record<string, KeyDef>> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Insert: { key: "Insert", code: "Insert", keyCode: 45 },
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, { key: `F${i + 1}`, code: `F${i + 1}`, keyCode: 112 + i }])),
}

const ALIASES: Readonly<Record<string, string>> = {
  Esc: "Escape",
  Return: "Enter",
  Up: "ArrowUp",
  Down: "ArrowDown",
  Left: "ArrowLeft",
  Right: "ArrowRight",
  " ": "Space",
}

/** A single printable character's key. */
const charKey = (c: string): KeyDef => {
  const upper = c.toUpperCase()
  if (/^[a-z]$/iu.test(c)) return { key: c, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: c }
  if (/^\d$/u.test(c)) return { key: c, code: `Digit${c}`, keyCode: c.charCodeAt(0), text: c }
  return { key: c, code: "", keyCode: 0, text: c }
}

/** A key press as CDP's two events (down and up), or why the name isn't a key. */
export interface KeyPress {
  readonly key: string
  readonly code: string
  readonly windowsVirtualKeyCode: number
  readonly modifiers: number
  readonly text: string | undefined
}

/** "Control+Shift+K" as a key press; null when it doesn't name one. */
export const parseKeys = (spec: string): KeyPress | null => {
  const parts = spec === "+" ? ["+"] : spec.split("+").filter((p) => p !== "")
  const last = parts.pop()
  if (last === undefined) return null
  let modifiers = 0
  for (const m of parts) {
    const bit = MODIFIERS[m]
    if (bit === undefined) return null
    modifiers |= bit
  }
  const named = NAMED[ALIASES[last] ?? last]
  const def = named ?? (Array.from(last).length === 1 ? charKey(last) : null)
  if (def === null) return null
  // A shortcut with Control, Alt or Meta types nothing.
  const typing = (modifiers & ~SHIFT) === 0
  return { key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, modifiers, text: typing ? def.text : undefined }
}
