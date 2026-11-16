import { clsx } from "clsx"
import { GitBranch, Plus, Trash2 } from "lucide-react"
import { useAtomValue } from "@effect/atom-react"
import { useState, type ReactNode } from "react"
import type { McpServer, Skill } from "@huntaway/contracts"
import { canRunAgents, mutate, query } from "@huntaway/client"
import { useShallow } from "../../boardHelpers"
import { HostSelect } from "../hosts/profileFields"
import { useBoard } from "../../../state/board"
import { useAction } from "../../../state/mutation"
import { Button, resultError, resultValue, useConfirm } from "../../ui"
import { SkillEditor } from "./SkillsSection"
import { McpEditor } from "./McpSection"
import { SourceCard, SourceAdder } from "./SkillSources"
import { describe, rejectFailure, type Change } from "./parts"

// Settings → Skills and MCP (6.4; huntaway's settings/agentTools/GlobalAgentToolsPanel.tsx). Every host here has skill
// sources and subfolders, so the old API checks are gone.

/**
 * A host's global skills and MCP servers, each switched on or off by default per profile. With several hosts, a picker
 * says whose: each host keeps its own, and only its own profiles' agents get them. It starts on this board's host if
 * that has profiles, else on the first that has: a board whose own host has none (a laptop's showing another machine's
 * projects) would otherwise add skills where no agent runs. The host is settled once the board has loaded and kept
 * while it's offline (a laptop asleep, a restart), so the panel doesn't remount, losing an open editor, or move a
 * change to another host; only a host gone from the board is given up.
 */
export function GlobalAgentToolsPanel() {
  const loaded = useBoard((b) => b.loaded)
  const known = useBoard(useShallow((b) => b.hosts.map((h): string => h.id)))
  const hosts = useBoard(useShallow((b) => b.hosts.filter(canRunAgents)))
  const withProfiles = useBoard(useShallow((b) => b.hosts.filter((h) => b.profiles.some((p) => p.host_id === h.id)).map((h) => h.id)))
  const fallback = useBoard((b) => b.localHostId ?? "")
  const [chosen, setChosen] = useState("")
  const profiled = hosts.filter((h) => withProfiles.includes(h.id))
  const first = profiled.find((h) => h.local) ?? profiled[0] ?? hosts.find((h) => h.local) ?? hosts[0]
  const settled = chosen !== "" && known.includes(chosen)
  if (loaded && !settled && first) setChosen(first.id)
  const hostId = settled ? chosen : (first?.id ?? fallback)
  if (!hostId) return null
  const offline = !hosts.some((h) => h.id === hostId)
  const several = hosts.filter((h) => h.id !== hostId).length > 0
  return <HostAgentTools key={hostId} hostId={hostId} offline={offline} picker={several ? <HostSelect value={hostId} onChange={setChosen} /> : null} />
}

/** The panel for one host: its tools, read while it's shown and again after each change (an `agentTools.*` mutation). */
function HostAgentTools({ hostId, offline, picker }: { hostId: string; offline: boolean; picker: ReactNode }) {
  const hostName = useBoard((b) => b.hosts.find((h) => h.id === hostId)?.name ?? "this host")
  const allProfiles = useBoard((b) => b.profiles)
  const profiles = allProfiles.filter((p) => p.host_id === hostId)
  const result = useAtomValue(query("agentTools.get", hostId, undefined))
  const tools = resultValue(result)
  const [editing, setEditing] = useState<{ kind: "skill"; item: Skill | null } | { kind: "server"; item: McpServer | null } | null>(null)
  const [addingSource, setAddingSource] = useState(false)
  const [updating, setUpdating] = useState<string | null>(null)
  // The switches' and Update's failures show under the list; a delete's shows in its dialog.
  const [changed, run] = useAction()
  const [, runConfirmed] = useAction()
  const err = changed.error ?? resultError(result)
  const confirmed = (change: Change) => runConfirmed(change).then(rejectFailure)
  const confirm = useConfirm()
  const isOn = (profileId: string, id: string) => !!tools?.profile_switches[profileId]?.[id]
  const ownSkills = tools?.skills.filter((s) => !s.source_id) ?? []
  const row = (item: Skill | McpServer) => {
    const server = "auto_allow" in item ? item : null
    const skill = "content" in item ? item : null
    return (
      <div key={item.id} className="space-y-1.5 px-3 py-2.5">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[12.5px]">{item.name}</div>
            <div className={clsx("truncate text-[11.5px] text-faint", server && "font-mono")}>{describe(item)}</div>
          </div>
          {server && (
            <label className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-muted" title="Run this server's tools without asking for approval">
              <input
                type="checkbox"
                checked={server.auto_allow}
                onChange={(e) =>
                  void run(mutate("agentTools.updateServer", hostId, { project_id: null, id: server.id, server: { auto_allow: e.target.checked } }))
                }
                className="accent-accent"
              />
              Allow all tools
            </label>
          )}
          {!skill?.source_id && (
            <>
              <Button size="sm" variant="ghost" onClick={() => setEditing(server ? { kind: "server", item: server } : { kind: "skill", item: skill })}>
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                title="Delete"
                onClick={() =>
                  confirm.ask({
                    title: `Delete ${item.name}`,
                    body: `Delete "${item.name}" from every profile and project on this host?`,
                    action: skill ? "Delete skill" : "Delete server",
                    danger: true,
                    onConfirm: () =>
                      skill
                        ? confirmed(mutate("agentTools.removeSkill", hostId, { project_id: null, id: skill.id }))
                        : server
                          ? confirmed(mutate("agentTools.removeServer", hostId, { project_id: null, id: server.id }))
                          : undefined,
                  })
                }
              >
                <Trash2 size={13} />
              </Button>
            </>
          )}
        </div>
        {profiles.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-faint">
            On by default in
            {profiles.map((p) => {
              const on = isOn(p.id, item.id)
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() =>
                    void run(mutate("agentTools.setSwitch", hostId, { scope: "profile", scope_id: p.id, item_id: item.id, enabled: on ? null : true }))
                  }
                  className={clsx(
                    "rounded-full border px-2 py-0.5 transition-colors",
                    on ? "border-accent/50 bg-accent/15 text-fg" : "border-line text-faint hover:text-muted",
                  )}
                  title={on ? `On by default in ${p.name}'s projects. Click to turn off.` : `Off by default in ${p.name}'s projects. Click to turn on.`}
                >
                  {p.name}
                </button>
              )
            })}
          </div>
        )}
      </div>
    )
  }
  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-[13px] font-semibold">Skills and MCP servers</h2>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => setAddingSource(true)}>
            <GitBranch size={13} /> Add from git
          </Button>
          <Button size="sm" onClick={() => setEditing({ kind: "skill", item: null })}>
            <Plus size={13} /> New skill
          </Button>
          <Button size="sm" onClick={() => setEditing({ kind: "server", item: null })}>
            <Plus size={13} /> Add MCP server
          </Button>
        </div>
      </div>
      <p className="mb-3 text-[12.5px] text-muted">
        Skills and MCP servers for agents, kept on the host rather than in a repository. Each profile switches them on or off by default for its projects, and a
        project can override that in its settings, or add its own. Skills can also come from a git repository, as with npx skills: add the repository, then
        switch on the skills you want.
      </p>
      {picker && <div className="mb-3 w-64">{picker}</div>}
      {offline && (
        <div className="mb-3 rounded-xl border border-dashed border-line p-3 text-[12.5px] text-muted">
          {hostName} is offline: its skills and MCP servers can't be read or changed until it's back.
        </div>
      )}
      {tools && profiles.length === 0 && (
        <div className="mb-3 rounded-xl border border-dashed border-line p-3 text-[12.5px] text-muted">
          {hostName} has no profiles, so its skills and MCP servers reach no agent and there is nothing to switch on.
          {picker ? " Pick the host your projects run on." : ""}
        </div>
      )}
      {tools && (
        <div className="space-y-3">
          {tools.skills.length + tools.mcp_servers.length === 0 && tools.skill_sources.length === 0 && (
            <div className="rounded-xl border border-dashed border-line p-4 text-[12.5px] text-faint">No global skills or MCP servers on this host yet.</div>
          )}
          {ownSkills.length > 0 && (
            <div className="rounded-xl border border-line">
              <div className="px-3 pt-2.5 text-[12px] font-medium text-muted">Skills</div>
              <div className="divide-y divide-line/70">{ownSkills.map(row)}</div>
            </div>
          )}
          {tools.skill_sources.map((src) => {
            const skills = tools.skills.filter((s) => s.source_id === src.id)
            return (
              <SourceCard
                key={src.id}
                source={src}
                skills={skills}
                profiles={profiles}
                isOn={isOn}
                updating={updating === src.id}
                renderSkill={row}
                onSwitchAll={(profileId, on) =>
                  void run(mutate("agentTools.setSwitch", hostId, { scope: "profile", scope_id: profileId, source_id: src.id, enabled: on ? true : null }))
                }
                onUpdate={() => {
                  setUpdating(src.id)
                  void run(mutate("agentTools.updateSource", hostId, { id: src.id })).finally(() => setUpdating(null))
                }}
                onRemove={() =>
                  confirm.ask({
                    title: `Remove ${src.name}`,
                    body: `Remove "${src.name}" and its ${skills.length} skill${skills.length === 1 ? "" : "s"} from every profile and project on this host?`,
                    action: "Remove source",
                    danger: true,
                    onConfirm: () => confirmed(mutate("agentTools.removeSource", hostId, { id: src.id })),
                  })
                }
              />
            )
          })}
          {tools.mcp_servers.length > 0 && (
            <div className="rounded-xl border border-line">
              <div className="px-3 pt-2.5 text-[12px] font-medium text-muted">MCP servers</div>
              <div className="divide-y divide-line/70">{tools.mcp_servers.map(row)}</div>
            </div>
          )}
        </div>
      )}
      {err && <div className="mt-2 text-xs text-red-400">{err}</div>}
      {confirm.dialog}
      {addingSource && (
        <SourceAdder
          onAdd={(url, ref, subdir) => mutate("agentTools.addSource", hostId, { url, ...(ref ? { ref } : {}), ...(subdir ? { subdir } : {}) })}
          onClose={() => setAddingSource(false)}
        />
      )}
      {editing?.kind === "skill" && (
        <SkillEditor
          skill={editing.item}
          onSave={(skill, content) =>
            skill
              ? mutate("agentTools.updateSkill", hostId, { project_id: null, id: skill.id, skill: { content } })
              : mutate("agentTools.addSkill", hostId, { project_id: null, skill: { content } })
          }
          onClose={() => setEditing(null)}
        />
      )}
      {editing?.kind === "server" && (
        <McpEditor
          server={editing.item}
          onSave={(server, b) =>
            server
              ? mutate("agentTools.updateServer", hostId, { project_id: null, id: server.id, server: b })
              : mutate("agentTools.addServer", hostId, { project_id: null, server: b })
          }
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  )
}
