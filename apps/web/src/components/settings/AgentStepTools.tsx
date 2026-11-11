import type { HostProject as Project } from "@huntaway/client"
import { clsx } from "clsx"
import { Check, Plus } from "lucide-react"
import { useState } from "react"
import { Input } from "../ui"

// 6.6's stub of the old AgentStepTools, which 6.4 (agent tools) replaces: the board's skills and the project's MCP
// servers to pick from need `agentTools`, which isn't on this server yet. Until then an agent step keeps the skills it
// names (more can be typed) and the servers it turns off, each to take off.

/** An agent step's skills (the ones it's asked to use) and MCP servers (all the project's, but those it turns off), as a thread has them. */
export function AgentStepTools({
  skills,
  disabled,
  onChange,
}: {
  project: Project
  configId: string | null
  skills: ReadonlyArray<string>
  disabled: ReadonlyArray<string>
  onChange: (patch: { skills?: ReadonlyArray<string>; disabled_mcp_servers?: ReadonlyArray<string> }) => void
}) {
  const [adding, setAdding] = useState("")
  const add = () => {
    const name = adding.trim().replace(/^[/$]+/, "")
    if (name && !skills.includes(name)) onChange({ skills: [...skills, name] })
    setAdding("")
  }
  return (
    <>
      <div className="space-y-1.5" data-testid="step-skills">
        <span className="block text-xs font-medium text-muted">Skills</span>
        <div className="flex flex-wrap gap-1">
          {skills.map((s) => (
            <Chip key={s} on onClick={() => onChange({ skills: skills.filter((x) => x !== s) })}>
              /{s}
            </Chip>
          ))}
          <div className="flex items-center">
            <Input
              className="h-6 w-28 text-[11.5px]"
              value={adding}
              placeholder="Another skill"
              onChange={(e) => setAdding(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return
                e.preventDefault()
                add()
              }}
              onBlur={add}
            />
            {adding.trim() && <Plus size={12} className="-ml-5 text-faint" />}
          </div>
        </div>
        <p className="text-[11.5px] text-faint">It's asked to use the ones picked, as a message naming them asks a thread's agent.</p>
      </div>
      {disabled.length > 0 && (
        <div className="space-y-1.5" data-testid="step-mcp-servers">
          <span className="block text-xs font-medium text-muted">MCP servers turned off</span>
          <div className="flex flex-wrap gap-1">
            {disabled.map((s) => (
              <Chip key={s} on={false} strike onClick={() => onChange({ disabled_mcp_servers: disabled.filter((x) => x !== s) })}>
                {s}
              </Chip>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

/** A name to pick: `strike` crosses it out when it isn't picked (a server turned off, rather than a skill not asked for). */
function Chip({ on, strike, onClick, children }: { on: boolean; strike?: boolean; onClick: () => void; children: string | string[] }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={clsx(
        "flex h-6 items-center gap-1 rounded-full border px-2 font-mono text-[11.5px]",
        on ? "border-accent/50 bg-accent/15 text-fg" : "border-line text-faint hover:text-muted",
        !on && strike && "line-through decoration-faint/60",
      )}
    >
      {on && <Check size={11} />}
      {children}
    </button>
  )
}
