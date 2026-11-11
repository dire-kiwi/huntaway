import { PERMISSION_MODES } from "@huntaway/client"
import { AgentConfigId, PermissionMode } from "@huntaway/contracts"
import { Schema } from "effect"
import { profileConfigLabel } from "../../boardHelpers"
import { useBoard } from "../../../state/board"
import type { ProjectForm, SetField } from "./ProjectSettings"
import { ConfigPicker } from "../ClaudeConfigs"
import { GithubAccountSelect } from "../hosts/profileFields"
import { Field, Input, Toggle } from "../../ui"

const isMode = Schema.is(PermissionMode)

/** The Agents tab: the model, permission mode, GitHub account and agent configs of the project's agents. */
export function AgentsTab({ form, hostMode, set }: { form: ProjectForm; hostMode: PermissionMode; set: SetField }) {
  return (
    <>
      <Field label="Model" hint="Overrides the profile default">
        <Input value={form.model ?? ""} placeholder="profile default" onChange={(e) => set("model", e.target.value)} />
      </Field>
      <Field label="Permission mode" hint="With 'Ask', tool approvals show up in the thread and flag the task as needing attention.">
        <select
          value={form.permission_mode ?? ""}
          onChange={(e) => {
            const v = e.target.value
            set("permission_mode", isMode(v) ? v : null)
          }}
          className="h-8 w-full rounded-md border border-line bg-panel px-2 text-[13px] outline-none"
        >
          <option value="">Host default ({PERMISSION_MODES.find((m) => m.id === hostMode)?.label})</option>
          {PERMISSION_MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} — {m.description}
            </option>
          ))}
        </select>
      </Field>
      <ProjectGithubAccount project={form} onChange={(a) => set("github_account", a)} />
      <ProjectConfigs project={form} onChange={(ids) => set("claude_config_ids", ids && ids.map((id) => AgentConfigId.make(id)))} />
    </>
  )
}

/** The project's own pick of Claude configs, or its profile's. */
function ProjectConfigs({ project, onChange }: { project: ProjectForm; onChange: (ids: ReadonlyArray<string> | null) => void }) {
  const profile = useBoard((s) => s.profiles.find((p) => p.host_id === project.host_id && p.id === project.profile_id))
  const label = useBoard((s) => (profile ? profileConfigLabel(s, profile) : ""))
  const own = project.claude_config_ids != null
  return (
    <div className="space-y-3 rounded-xl border border-line p-4">
      <div className="space-y-1.5">
        <Toggle checked={own} onChange={(v) => onChange(v ? (profile?.claude_config_ids ?? []) : null)} label="Use its own agent configs" />
        <div className="text-[12px] text-faint">
          {own ? "New tasks pick from these; with more than one, they ask which, starting with the default." : `Uses the profile's: ${label}.`}
        </div>
      </div>
      {own && <ConfigPicker hostId={project.host_id} value={project.claude_config_ids ?? []} onChange={onChange} />}
    </div>
  )
}

/** The project's own GitHub account, or its profile's. */
function ProjectGithubAccount({ project, onChange }: { project: ProjectForm; onChange: (account: string | null) => void }) {
  const profile = useBoard((s) => s.profiles.find((p) => p.host_id === project.host_id && p.id === project.profile_id))
  return (
    <Field label="GitHub account" hint="The account its agents act as on GitHub through their gh tools. Overrides the profile's.">
      <GithubAccountSelect
        hostId={project.host_id}
        value={project.github_account ?? ""}
        onChange={(a) => onChange(a || null)}
        inherit={(active) => `Profile's (${profile?.github_account || (active ? `gh's active account, ${active}` : "gh's active account")})`}
      />
    </Field>
  )
}
