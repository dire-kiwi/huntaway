import { PERMISSION_MODES } from "@huntaway/client"
import { AgentConfigId, PermissionMode } from "@huntaway/contracts"
import { Schema } from "effect"
import { profileConfigLabel } from "../../boardHelpers"
import { useBoard } from "../../../state/board"
import type { ProjectForm, SetField } from "./ProjectSettings"
import { ConfigPicker } from "../ClaudeConfigs"
import { GithubAccountSelect } from "../hosts/profileFields"
import { Field, Input } from "../../ui"
import { selectClass } from "./parts"

const isMode = Schema.is(PermissionMode)

/** The Agents tab: the agent configs, model, permission mode and GitHub account of the project's agents. */
export function AgentsTab({ form, hostMode, set }: { form: ProjectForm; hostMode: PermissionMode; set: SetField }) {
  return (
    <>
      <ProjectConfigs project={form} onChange={(ids) => set("claude_config_ids", ids && ids.map((id) => AgentConfigId.make(id)))} />
      <Field label="Model">
        <Input value={form.model ?? ""} placeholder="The profile's default" onChange={(e) => set("model", e.target.value)} />
      </Field>
      <Field
        label="Permission mode"
        help="What agents may do without asking. With Ask, tool approvals show in the thread and flag the task as needing attention."
      >
        <select
          value={form.permission_mode ?? ""}
          onChange={(e) => {
            const v = e.target.value
            set("permission_mode", isMode(v) ? v : null)
          }}
          className={selectClass}
        >
          <option value="">The host's default ({PERMISSION_MODES.find((m) => m.id === hostMode)?.label})</option>
          {PERMISSION_MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} — {m.description}
            </option>
          ))}
        </select>
      </Field>
      <ProjectGithubAccount project={form} onChange={(a) => set("github_account", a)} />
    </>
  )
}

/** The project's own pick of Claude configs, or its profile's. */
function ProjectConfigs({ project, onChange }: { project: ProjectForm; onChange: (ids: ReadonlyArray<string> | null) => void }) {
  const profile = useBoard((s) => s.profiles.find((p) => p.host_id === project.host_id && p.id === project.profile_id))
  const label = useBoard((s) => (profile ? profileConfigLabel(s, profile) : ""))
  const own = project.claude_config_ids != null
  return (
    <div className="space-y-2">
      <Field label="Agent configs" help="The configs new tasks pick from. With more than one, a new task asks which, starting with the default.">
        <select
          value={own ? "own" : "profile"}
          onChange={(e) => onChange(e.target.value === "own" ? (profile?.claude_config_ids ?? []) : null)}
          className={selectClass}
        >
          <option value="profile">The profile's ({label})</option>
          <option value="own">This project's own</option>
        </select>
      </Field>
      {own && <ConfigPicker hostId={project.host_id} value={project.claude_config_ids ?? []} onChange={onChange} />}
    </div>
  )
}

/** The project's own GitHub account, or its profile's. */
function ProjectGithubAccount({ project, onChange }: { project: ProjectForm; onChange: (account: string | null) => void }) {
  const profile = useBoard((s) => s.profiles.find((p) => p.host_id === project.host_id && p.id === project.profile_id))
  return (
    <Field label="GitHub account" help="The account the project's agents act as on GitHub, through their gh tools.">
      <GithubAccountSelect
        hostId={project.host_id}
        value={project.github_account ?? ""}
        onChange={(a) => onChange(a || null)}
        inherit={(active) => `The profile's (${profile?.github_account || (active ? `gh's active account, ${active}` : "gh's active account")})`}
      />
    </Field>
  )
}
