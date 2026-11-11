import { clsx } from "clsx"
import { useCallback, useEffect, useRef, useState } from "react"
import type { McpServer, ProjectAgentTools as AgentTools, SeenTools, Skill } from "@huntaway/contracts"
import type { HostProject as Project } from "@huntaway/client"
import { useRpc } from "../../state/rpc"
import { errorText, useConfirm } from "../ui"
import { describe } from "./agentTools/parts"
import { SkillsSection } from "./agentTools/SkillsSection"
import { McpSection } from "./agentTools/McpSection"

// A project's skills and MCP servers (6.4; huntaway's settings/AgentTools.tsx): its own, its switches for the host's
// global ones, and the ones from elsewhere it turns off. The project settings' Skills and MCP tab mounts
// `ProjectAgentTools` (6.12).

type DisabledKey = "disabled_skills" | "disabled_mcp_servers"
type Disabled = Pick<AgentTools, DisabledKey>
/** `t` with the lists of others' skills and servers it turns off as `d` has them. */
const withDisabled = (t: AgentTools, d: Disabled): AgentTools =>
  Object.assign({}, t, { disabled_skills: d.disabled_skills, disabled_mcp_servers: d.disabled_mcp_servers })
const toggleIn = (list: ReadonlyArray<string>, name: string, off: boolean) => (off ? [...list.filter((n) => n !== name), name] : list.filter((n) => n !== name))

/** The project's own skills and MCP servers, and switches for the ones its agents get from elsewhere. */
export function ProjectAgentTools({ project }: { project: Project }) {
  const rpc = useRpc()
  const [tools, setTools] = useState<AgentTools | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const hostId = project.host_id
  // Switches for skills and servers from elsewhere save the whole list, so each click builds on
  // the ones before it (not on what was last rendered) and the saves go one at a time.
  const wanted = useRef<Disabled | null>(null)
  const saving = useRef(0)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const show = useCallback((t: AgentTools) => {
    // While switches are saving, keep showing them as clicked.
    setTools(saving.current && wanted.current ? withDisabled(t, wanted.current) : t)
    if (!saving.current) wanted.current = { disabled_skills: t.disabled_skills, disabled_mcp_servers: t.disabled_mcp_servers }
  }, [])
  const reload = useCallback(
    () =>
      rpc(hostId, "agentTools.project", { project_id: project.id }).then(
        (t) => {
          show(t)
          setErr(null)
        },
        (e: unknown) => setErr(errorText(e)),
      ),
    [rpc, hostId, project.id, show],
  )
  useEffect(() => {
    void reload()
  }, [reload])
  const confirm = useConfirm()
  if (!tools) return err ? <div className="text-xs text-red-400">{err}</div> : null
  const run = (fn: () => Promise<unknown>) => {
    setErr(null)
    fn().then(reload, (e: unknown) => setErr(errorText(e)))
  }
  const seen: ReadonlyArray<SeenTools> = Object.values(tools.seen)
  const lastSeen = seen
    .map((s) => s.at)
    .toSorted()
    .pop()
  const toggleOther = (key: DisabledKey, name: string, on: boolean) => {
    const set = (off: boolean) => {
      const base = wanted.current ?? { disabled_skills: tools.disabled_skills, disabled_mcp_servers: tools.disabled_mcp_servers }
      const now: Disabled =
        key === "disabled_skills"
          ? { disabled_skills: toggleIn(base.disabled_skills, name, off), disabled_mcp_servers: base.disabled_mcp_servers }
          : { disabled_skills: base.disabled_skills, disabled_mcp_servers: toggleIn(base.disabled_mcp_servers, name, off) }
      wanted.current = now
      setTools((t) => t && withDisabled(t, now))
    }
    set(!on)
    setErr(null)
    saving.current++
    queue.current = queue.current.then(async () => {
      let saved: AgentTools | null = null
      try {
        saved = await rpc(hostId, "agentTools.updateProject", { project_id: project.id, patch: { [key]: wanted.current?.[key] ?? [] } })
      } catch (e) {
        setErr(errorText(e))
        set(on)
      }
      saving.current--
      if (saved && !saving.current) show(saved)
    })
  }
  const globalNames = new Set([...tools.global_skills, ...tools.global_mcp_servers].map((g) => g.name))
  const sourceNames = new Map(tools.skill_sources.map((src) => [src.id, src.name]))
  const shared = (items: ReadonlyArray<Skill | McpServer>, own: ReadonlyArray<Skill | McpServer>, what: string) =>
    items.length ? (
      <SharedList
        what={what}
        items={items}
        sourceName={(i) => ("source_id" in i && i.source_id ? sourceNames.get(i.source_id) : undefined)}
        replaced={new Set(own.filter((o) => o.enabled).map((o) => o.name))}
        profileOn={(id) => !!tools.profile_switches[id]}
        override={(id) => tools.project_switches[id] ?? null}
        onChange={(id, enabled) => run(() => rpc(hostId, "agentTools.setSwitch", { scope: "project", scope_id: project.id, item_id: id, enabled }))}
      />
    ) : null
  return (
    <>
      <SkillsSection
        tools={tools}
        shared={shared(tools.global_skills, tools.skills, "skills")}
        seenSkills={dedupe(seen.flatMap((s) => s.skills))
          .map((s) => s.name)
          .filter((n) => !globalNames.has(n))}
        lastSeen={lastSeen}
        onToggleOther={(name, on) => toggleOther("disabled_skills", name, on)}
        onToggle={(s, enabled) => run(() => rpc(hostId, "agentTools.updateSkill", { project_id: project.id, id: s.id, skill: { enabled } }))}
        onDelete={(s) =>
          confirm.ask({
            title: `Delete skill ${s.name}`,
            body: `Delete the skill "${s.name}"?`,
            action: "Delete skill",
            danger: true,
            onConfirm: () => rpc(hostId, "agentTools.removeSkill", { project_id: project.id, id: s.id }).then(reload),
          })
        }
        onSave={async (skill, content) => {
          if (skill) await rpc(hostId, "agentTools.updateSkill", { project_id: project.id, id: skill.id, skill: { content } })
          else await rpc(hostId, "agentTools.addSkill", { project_id: project.id, skill: { content } })
          await reload()
        }}
      />
      <McpSection
        tools={tools}
        shared={shared(tools.global_mcp_servers, tools.mcp_servers, "MCP servers")}
        seenServers={dedupe(
          seen.flatMap((s) => s.mcp_servers.flatMap((m) => (m.name === null ? [] : [{ name: m.name, status: m.status ?? null, source: m.source ?? null }]))),
        ).filter((s) => !globalNames.has(s.name))}
        lastSeen={lastSeen}
        onToggleOther={(name, on) => toggleOther("disabled_mcp_servers", name, on)}
        onUpdate={(s, b) => run(() => rpc(hostId, "agentTools.updateServer", { project_id: project.id, id: s.id, server: b }))}
        onDelete={(s) =>
          confirm.ask({
            title: `Delete MCP server ${s.name}`,
            body: `Delete the MCP server "${s.name}"?`,
            action: "Delete server",
            danger: true,
            onConfirm: () => rpc(hostId, "agentTools.removeServer", { project_id: project.id, id: s.id }).then(reload),
          })
        }
        onSave={async (server, b) => {
          if (server) await rpc(hostId, "agentTools.updateServer", { project_id: project.id, id: server.id, server: b })
          else await rpc(hostId, "agentTools.addServer", { project_id: project.id, server: b })
          await reload()
        }}
      />
      {err && <div className="text-xs text-red-400">{err}</div>}
      {confirm.dialog}
    </>
  )
}

function dedupe<T extends { name: string }>(items: ReadonlyArray<T>): T[] {
  const byName = new Map<string, T>()
  for (const i of items) if (!byName.has(i.name)) byName.set(i.name, i)
  return [...byName.values()]
}

/** A project's switches for the host's global skills or servers: its profile's default, or on or off. */
function SharedList({
  what,
  items,
  sourceName,
  replaced,
  profileOn,
  override,
  onChange,
}: {
  what: string
  items: ReadonlyArray<Skill | McpServer>
  /** The skill source (repository) an item comes from, if it does. */
  sourceName: (i: Skill | McpServer) => string | undefined
  /** Names of the project's own ones that are on, which take the place of global ones with the same name. */
  replaced: Set<string>
  profileOn: (id: string) => boolean
  override: (id: string) => boolean | null
  onChange: (id: string, enabled: boolean | null) => void
}) {
  return (
    <div className="rounded-md border border-line/70">
      <div className="px-3 pt-2 text-[12px] text-muted">Global {what}</div>
      <div className="divide-y divide-line/70">
        {items.map((i) => {
          const o = override(i.id)
          const on = o ?? profileOn(i.id)
          const mine = replaced.has(i.name)
          return (
            <div key={i.id} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className={clsx("font-mono text-[12.5px]", (!on || mine) && "text-faint")}>{i.name}</div>
                <div className="truncate text-[11.5px] text-faint">
                  {mine ? (
                    "Replaced by this project's own, while that's on"
                  ) : (
                    <>
                      {sourceName(i) && <span className="mr-1.5 rounded bg-hover px-1 py-px text-[10.5px] text-muted">{sourceName(i)}</span>}
                      {describe(i)}
                    </>
                  )}
                </div>
              </div>
              <select
                value={o === null ? "" : o ? "on" : "off"}
                onChange={(e) => onChange(i.id, e.target.value === "" ? null : e.target.value === "on")}
                className="h-7 shrink-0 rounded-md border border-line bg-panel px-2 text-[12px] outline-none"
              >
                <option value="">Profile default ({profileOn(i.id) ? "on" : "off"})</option>
                <option value="on">On</option>
                <option value="off">Off</option>
              </select>
            </div>
          )
        })}
      </div>
    </div>
  )
}
