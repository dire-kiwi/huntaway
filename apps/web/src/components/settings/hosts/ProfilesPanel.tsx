import { canRunAgents, type HostProfile as Profile } from "@huntaway/client"
import { Plus, Trash2 } from "lucide-react"
import { useMemo, useState } from "react"
import { defaultAgentHost, profileConfigLabel, profileNames } from "../../boardHelpers"
import { useBoard } from "../../../state/board"
import { Button, Modal, useConfirm } from "../../ui"
import { ProfileForm, usesAsana } from "./ProfileForm"
import { useMutation } from "../../../state/mutation"

// A profile has agent configs on every host (docs/plan/09-frontend.md), so the old "Copy login" for a profile with a
// folder of its own is gone: logins are copied from Settings → Agent configs.

export function ProfilesPanel() {
  // The confirm dialog shows why a delete was refused.
  const [, deleteProfile] = useMutation("profiles.delete")
  const profiles = useBoard((s) => s.profiles)
  const hosts = useBoard((s) => s.hosts)
  const claudeConfigs = useBoard((s) => s.claudeConfigs)
  const [editing, setEditing] = useState<{ host: string; profile?: Profile; name?: string } | null>(null)
  const names = useMemo(() => profileNames(profiles), [profiles])
  const hostName = (id: string): string => hosts.find((h) => h.id === id)?.name ?? id.slice(0, 8)
  const online = hosts.filter((h) => canRunAgents(h))
  const agentHost = defaultAgentHost(hosts)
  const confirm = useConfirm()
  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[13px] font-semibold">Profiles</h2>
        <Button size="sm" disabled={!agentHost} onClick={() => agentHost && setEditing({ host: agentHost })}>
          <Plus size={13} /> Add profile
        </Button>
      </div>
      <p className="mb-3 text-[12.5px] text-muted">
        Profiles are set up on each host and appear together by name. Each picks which of its host's agent configs (Claude Code or Codex) its agents use; with
        more than one, new tasks ask which.
      </p>
      <div className="space-y-3">
        {names.map((name) => {
          const rows = profiles.filter((p) => p.name === name)
          const missing = online.filter((h) => !rows.some((p) => p.host_id === h.id))
          return (
            <div key={name} className="rounded-xl border border-line">
              <div className="border-b border-line px-4 py-2.5 text-[13px] font-medium">{name}</div>
              {rows.map((p) => (
                <div key={`${p.host_id}:${p.id}`} className="flex items-center gap-3 px-4 py-2.5">
                  <div className="w-28 shrink-0 truncate text-[12px] text-muted">{hostName(p.host_id)}</div>
                  <div className="min-w-0 flex-1 truncate text-[11.5px] text-faint">
                    {profileConfigLabel({ claudeConfigs }, p)}
                    {p.default_model ? ` · ${p.default_model}` : ""}
                    {p.github_account ? ` · GitHub: ${p.github_account}` : ""}
                    {p.clone_dir ? ` · clones into ${p.clone_dir}` : ""}
                    {!usesAsana(p) ? " · Asana off" : p.asana_user ? ` · Asana: ${p.asana_user}` : ""}
                    {p.assistant_host ? ` · assistant on ${hostName(p.assistant_host)}` : ""}
                    {p.agent_access.length ? ` · agents from ${p.agent_access.includes("*") ? "every profile" : p.agent_access.join(", ")} can use it` : ""}
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => setEditing({ host: p.host_id, profile: p })}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    title="Delete"
                    onClick={() =>
                      confirm.ask({
                        title: `Delete profile ${p.name}`,
                        body: `Delete profile "${p.name}" on ${hostName(p.host_id)}, with all its projects and tasks there?`,
                        action: "Delete profile",
                        danger: true,
                        onConfirm: () => deleteProfile(p.host_id, { id: p.id }),
                      })
                    }
                  >
                    <Trash2 size={13} />
                  </Button>
                </div>
              ))}
              {missing.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2 text-[11.5px] text-faint">
                  Not set up on:
                  {missing.map((h) => (
                    <button key={h.id} className="text-accent hover:underline" onClick={() => setEditing({ host: h.id, name })}>
                      {h.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
      {editing && (
        <Modal title={editing.profile ? `Edit profile on ${hostName(editing.host)}` : "Add profile"} onClose={() => setEditing(null)}>
          <ProfileForm hostId={editing.host} initial={editing.profile} name={editing.name} onDone={() => setEditing(null)} onCancel={() => setEditing(null)} />
        </Modal>
      )}
      {confirm.dialog}
    </section>
  )
}
