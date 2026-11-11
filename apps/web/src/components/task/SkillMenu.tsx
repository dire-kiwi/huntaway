import type { HostTask as Task } from "@huntaway/client"
import { Layers, Sparkles } from "lucide-react"
import type { KeyboardEvent } from "react"

// The composer's `/` menu lists the skills a task's agent can be asked to use (the host's `tasks.skills`) and the
// board's own `/compact`, `/plan` and `/new`. A task's skills come with `AgentTools` (6.4): until then the menu is
// inert, and a message that starts with one is sent as typed (the board still handles its own commands).

/** Something the composer's `/` menu offers: a skill, or `/compact`, `/plan` or `/new`, which the board handles itself. */
export interface SkillItem {
  name: string
  description: string
  /** How a message calls it: `/name` for Claude Code, `$name` for a Codex skill. */
  prefix: "/" | "$"
  builtin?: boolean | undefined
  /** What a builtin takes after its name, for the hint. */
  args?: string | undefined
}

/** The `/` menu, inert on this server until skills come over (6.4). */
export function useSkillMenu(
  _task: Task,
  _text: string,
  _setText: (t: string) => void,
): { open: boolean; hint: SkillItem | null; onKeyDown: (e: KeyboardEvent) => boolean } {
  return { open: false, hint: null, onKeyDown: () => false }
}

export function SkillMenu(_props: { menu: ReturnType<typeof useSkillMenu> }) {
  return null
}

/** What the command the message starts with does. */
export function SkillHint({ item }: { item: SkillItem }) {
  return (
    <div className="flex items-center gap-2 border-b border-line px-4 py-1.5 text-[12px] text-faint">
      {item.builtin ? <Layers size={12} className="shrink-0" /> : <Sparkles size={12} className="shrink-0" />}
      <span className="shrink-0 font-mono text-muted">
        {item.prefix}
        {item.name} {item.args ?? "[arguments]"}
      </span>
      <span className="min-w-0 truncate" title={item.description || undefined}>
        {item.description || (item.prefix === "$" ? "Ask the agent to use this skill" : "Run this skill")}
      </span>
    </div>
  )
}
