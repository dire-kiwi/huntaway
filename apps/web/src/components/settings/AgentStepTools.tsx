import { clsx } from "clsx"
import { Check, Plus } from "lucide-react"
import { useAtomValue } from "@effect/atom-react"
import { useState } from "react"
import type { ProjectAgentTools as AgentTools } from "@huntaway/contracts"
import { query, type HostProject as Project } from "@huntaway/client"
import { Input, resultError, resultValue } from "../ui"

// A workflow agent step's skills and MCP servers (6.4; huntaway's settings/AgentStepTools.tsx), for the workflow
// inspector (6.6 mounts it).

const sorted = (l: string[]) => [...new Set(l)].toSorted((a, b) => a.localeCompare(b))

/** The skills and MCP servers a project's agents have, to pick from: the board's (its own and the global ones on for it) and those runs reported. */
export function stepToolChoices(t: AgentTools, configId: string | null): { skills: string[]; servers: string[] } {
  const on = (id: string) => t.project_switches[id] ?? t.profile_switches[id] ?? false
  const seen = t.seen[configId ?? ""] ?? t.seen[""]
  const skills = [
    ...t.skills.filter((s) => s.enabled).map((s) => s.name),
    ...t.global_skills.filter((s) => s.enabled && on(s.id)).map((s) => s.name),
    ...(seen?.skills ?? []).map((s) => s.name),
  ].filter((n) => !t.disabled_skills.includes(n))
  const servers = [
    ...t.mcp_servers.filter((s) => s.enabled).map((s) => s.name),
    ...t.global_mcp_servers.filter((s) => s.enabled && on(s.id)).map((s) => s.name),
    ...(seen?.mcp_servers ?? []).flatMap((s) => (s.name === null ? [] : [s.name])),
  ].filter((n) => !t.disabled_mcp_servers.includes(n))
  return { skills: sorted(skills), servers: sorted(servers) }
}

/** An agent step's skills (the ones it's asked to use) and MCP servers (all the project's, but those it turns off), as a thread has them. */
export function AgentStepTools({
  project,
  configId,
  skills,
  disabled,
  onChange,
}: {
  project: Project
  configId: string | null
  skills: ReadonlyArray<string>
  disabled: ReadonlyArray<string>
  onChange: (patch: { skills?: string[]; disabled_mcp_servers?: string[] }) => void
}) {
  const result = useAtomValue(query("agentTools.project", project.host_id, { project_id: project.id }))
  const tools = resultValue(result)
  const failed = !tools && resultError(result) !== null
  const [adding, setAdding] = useState("")
  const choices = tools ? stepToolChoices(tools, configId) : { skills: [], servers: [] }
  // What it has that isn't on the list (a skill from elsewhere, a server since removed) shows too, to take off.
  const skillNames = [...choices.skills, ...skills.filter((s) => !choices.skills.includes(s))]
  const serverNames = [...choices.servers, ...disabled.filter((s) => !choices.servers.includes(s))]
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
          {skillNames.map((s) => (
            <Chip key={s} on={skills.includes(s)} onClick={() => onChange({ skills: skills.includes(s) ? skills.filter((x) => x !== s) : [...skills, s] })}>
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
        <p className="text-[11.5px] text-faint">
          {tools && !choices.skills.length ? "The project's agents have no skills from the board yet. " : ""}
          It's asked to use the ones picked, as a message naming them asks a thread's agent.
        </p>
      </div>
      <div className="space-y-1.5" data-testid="step-mcp-servers">
        <span className="block text-xs font-medium text-muted">MCP servers</span>
        {serverNames.length ? (
          <div className="flex flex-wrap gap-1">
            {serverNames.map((s) => (
              <Chip
                key={s}
                on={!disabled.includes(s)}
                strike
                onClick={() => onChange({ disabled_mcp_servers: disabled.includes(s) ? disabled.filter((x) => x !== s) : [...disabled, s] })}
              >
                {s}
              </Chip>
            ))}
          </div>
        ) : (
          <p className="text-[11.5px] text-faint">{failed ? "Couldn't read the project's MCP servers." : tools ? "The project's agents have none." : "…"}</p>
        )}
        {serverNames.length > 0 && (
          <p className="text-[11.5px] text-faint">It has the project's servers, as its threads do: click one to turn it off for this step.</p>
        )}
      </div>
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
