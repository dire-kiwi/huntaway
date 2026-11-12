import { clsx } from "clsx"
import { GitBranch, Plus, Trash2 } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import type { GlobalAgentTools, McpServer, Skill } from "@huntaway/contracts"
import { canRunAgents } from "@huntaway/client"
import { useBoard } from "../../../state/board"
import { useRpc } from "../../../state/rpc"
import { Button, errorText, useConfirm } from "../../ui"
import { SkillEditor } from "./SkillsSection"
import { McpEditor } from "./McpSection"
import { SourceCard, SourceAdder } from "./SkillSources"
import { describe } from "./parts"

// Settings → Skills and MCP (6.4; huntaway's settings/agentTools/GlobalAgentToolsPanel.tsx). Picking another host's is
// M7's (the hosts); every host here has skill sources and subfolders, so the old API checks are gone.

/** A host's global skills and MCP servers, each switched on or off by default per profile. */
export function GlobalAgentToolsPanel() {
  const rpc = useRpc()
  const hostId = useBoard((b) => {
    const usable = b.hosts.filter(canRunAgents)
    return usable.find((h) => h.local)?.id ?? usable[0]?.id ?? b.localHostId ?? ""
  })
  const allProfiles = useBoard((b) => b.profiles)
  const profiles = allProfiles.filter((p) => p.host_id === hostId)
  const [tools, setTools] = useState<GlobalAgentTools | null>(null)
  const [editing, setEditing] = useState<{ kind: "skill"; item: Skill | null } | { kind: "server"; item: McpServer | null } | null>(null)
  const [addingSource, setAddingSource] = useState(false)
  const [updating, setUpdating] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const reload = useCallback(() => {
    if (!hostId) return Promise.resolve()
    return rpc(hostId, "agentTools.get", undefined).then(setTools, (e: unknown) => setErr(errorText(e)))
  }, [rpc, hostId])
  useEffect(() => {
    void reload()
  }, [reload])
  const confirm = useConfirm()
  if (!hostId) return null
  const runAsync = async (fn: () => Promise<unknown>) => {
    setErr(null)
    try {
      await fn()
      await reload()
    } catch (e) {
      setErr(errorText(e))
    }
  }
  const run = (fn: () => Promise<unknown>) => void runAsync(fn)
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
                  run(() => rpc(hostId, "agentTools.updateServer", { project_id: null, id: server.id, server: { auto_allow: e.target.checked } }))
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
                      (skill
                        ? rpc(hostId, "agentTools.removeSkill", { project_id: null, id: skill.id })
                        : server
                          ? rpc(hostId, "agentTools.removeServer", { project_id: null, id: server.id })
                          : Promise.resolve()
                      ).then(reload),
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
                    run(() => rpc(hostId, "agentTools.setSwitch", { scope: "profile", scope_id: p.id, item_id: item.id, enabled: on ? null : true }))
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
                  run(() => rpc(hostId, "agentTools.setSwitch", { scope: "profile", scope_id: profileId, source_id: src.id, enabled: on ? true : null }))
                }
                onUpdate={() => {
                  setUpdating(src.id)
                  void runAsync(() => rpc(hostId, "agentTools.updateSource", { id: src.id })).finally(() => setUpdating(null))
                }}
                onRemove={() =>
                  confirm.ask({
                    title: `Remove ${src.name}`,
                    body: `Remove "${src.name}" and its ${skills.length} skill${skills.length === 1 ? "" : "s"} from every profile and project on this host?`,
                    action: "Remove source",
                    danger: true,
                    onConfirm: () => rpc(hostId, "agentTools.removeSource", { id: src.id }).then(reload),
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
          onAdd={async (url, ref, subdir) => {
            await rpc(hostId, "agentTools.addSource", { url, ...(ref ? { ref } : {}), ...(subdir ? { subdir } : {}) })
            await reload()
          }}
          onClose={() => setAddingSource(false)}
        />
      )}
      {editing?.kind === "skill" && (
        <SkillEditor
          skill={editing.item}
          onSave={async (skill, content) => {
            if (skill) await rpc(hostId, "agentTools.updateSkill", { project_id: null, id: skill.id, skill: { content } })
            else await rpc(hostId, "agentTools.addSkill", { project_id: null, skill: { content } })
            await reload()
          }}
          onClose={() => setEditing(null)}
        />
      )}
      {editing?.kind === "server" && (
        <McpEditor
          server={editing.item}
          onSave={async (server, b) => {
            if (server) await rpc(hostId, "agentTools.updateServer", { project_id: null, id: server.id, server: b })
            else await rpc(hostId, "agentTools.addServer", { project_id: null, server: b })
            await reload()
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  )
}
