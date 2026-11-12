import { useState } from "react"
import { DEFAULT_SHORTCUTS, FIXED_SHORTCUTS, isShortcutKey, saveShortcut, shortcutTaken, SHORTCUTS, useShortcutKeys, type ShortcutId } from "../../shortcuts"
import { Kbd } from "../ui"

/** Settings → Keyboard shortcuts (HA-396): the page's keys, and a new key for the ones that can have one. */
export function ShortcutsPanel() {
  const keys = useShortcutKeys()
  // The shortcut a key is being picked for, and why the last key pressed wasn't taken.
  const [picking, setPicking] = useState<ShortcutId | null>(null)
  const [problem, setProblem] = useState<{ id: ShortcutId; text: string } | null>(null)
  const pick = (id: ShortcutId | null) => {
    setPicking(id)
    setProblem(null)
  }
  /** Gives `id` the key (its default with null) unless something else has it, which it says instead. */
  const save = (id: ShortcutId, key: string | null) => {
    const taken = shortcutTaken(keys, id, key ?? DEFAULT_SHORTCUTS[id])
    if (taken) return setProblem({ id, text: `${key ?? DEFAULT_SHORTCUTS[id]} is “${taken}” here` })
    saveShortcut(id, key)
    pick(null)
  }
  const groups = [...new Set(["Anywhere", ...SHORTCUTS.map((s) => s.group), ...FIXED_SHORTCUTS.map((s) => s.group)])]

  return (
    <section>
      <h2 className="mb-3 text-[13px] font-semibold">Keyboard shortcuts</h2>
      <div className="space-y-4 rounded-xl border border-line p-4 text-[12.5px] text-muted">
        <p>
          The keys the board takes when you&apos;re not typing in a field. Click one that can change, then press its new key (Esc leaves it as it is). The
          changes are kept in this browser.
        </p>
        {groups.map((group) => (
          <div key={group} className="space-y-1.5">
            <div className="text-[12px] font-medium text-fg">{group}</div>
            {SHORTCUTS.filter((s) => s.group === group).map((s) => (
              <div key={s.id} className="flex min-h-6 items-center gap-2">
                <span className="min-w-0 flex-1">{s.label}</span>
                {problem?.id === s.id && <span className="text-amber-200">{problem.text}</span>}
                {keys[s.id] !== DEFAULT_SHORTCUTS[s.id] && picking !== s.id && (
                  <button type="button" className="text-faint hover:text-fg" aria-label={`Reset ${s.label}`} onClick={() => save(s.id, null)}>
                    Reset to <Kbd>{DEFAULT_SHORTCUTS[s.id]}</Kbd>
                  </button>
                )}
                <button
                  type="button"
                  aria-label={`${s.label} (${group}): ${keys[s.id]}. Change`}
                  title="Change"
                  className="rounded-md border border-line px-1.5 py-0.5 hover:border-line-strong focus:border-accent/50 focus:outline-none"
                  onClick={(e) => {
                    // Safari doesn't give a clicked button the focus, which the key press needs.
                    e.currentTarget.focus()
                    pick(s.id)
                  }}
                  onBlur={() => picking === s.id && pick(null)}
                  onKeyDown={(e) => {
                    if (picking !== s.id) return
                    // Tab moves on, and a key held with Ctrl, Alt or Cmd is the browser's.
                    if (e.key === "Tab" || e.ctrlKey || e.metaKey || e.altKey || ["Shift", "Control", "Alt", "Meta"].includes(e.key)) return
                    // Not the press that opened this (Enter or Space on the button), nor a shortcut of the page's.
                    e.preventDefault()
                    e.stopPropagation()
                    if (e.key === "Escape") return pick(null)
                    if (!isShortcutKey(e.key)) return setProblem({ id: s.id, text: "Press a letter or symbol" })
                    save(s.id, e.key)
                  }}
                >
                  {picking === s.id ? <span className="text-[11px] text-fg">Press a key…</span> : <Kbd>{keys[s.id]}</Kbd>}
                </button>
              </div>
            ))}
            {FIXED_SHORTCUTS.filter((s) => s.group === group).map((s) => (
              <div key={s.label} className="flex min-h-6 items-center gap-2">
                <span className="min-w-0 flex-1">{s.label}</span>
                <span className="px-1.5">
                  <Kbd>{s.keys}</Kbd>
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  )
}
