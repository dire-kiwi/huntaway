import { hostSupports, PERMISSION_MODES, type Host, type PermissionMode, type Project } from "../../../api";
import { profileConfigLabel, useStore } from "../../../store";
import { ConfigPicker } from "../ClaudeConfigs";
import { GithubAccountSelect } from "../Hosts";
import { Field, Input, Toggle } from "../../ui";

/** The Agents tab: the model, permission mode, GitHub account and agent configs of the project's agents. */
export function AgentsTab({
  form,
  host,
  hostMode,
  set,
}: {
  form: Project;
  host: Host | undefined;
  hostMode: PermissionMode;
  set: <K extends keyof Project>(k: K, v: Project[K]) => void;
}) {
  return (
    <>
      <Field label="Model" hint="Overrides the profile default">
        <Input value={form.model ?? ""} placeholder="profile default" onChange={(e) => set("model", e.target.value)} />
      </Field>
      <Field label="Permission mode" hint="With 'Ask', tool approvals show up in the thread and flag the task as needing attention.">
        <select
          value={form.permission_mode ?? ""}
          onChange={(e) => set("permission_mode", (e.target.value || null) as PermissionMode | null)}
          className="h-8 w-full rounded-md border border-line bg-panel px-2 text-[13px] outline-none"
        >
          {hostSupports(host, 2) && <option value="">Host default ({PERMISSION_MODES.find((m) => m.id === hostMode)?.label})</option>}
          {PERMISSION_MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} — {m.description}
            </option>
          ))}
        </select>
      </Field>
      {hostSupports(host, 50) && <ProjectGithubAccount project={form} onChange={(a) => set("github_account", a)} />}
      {hostSupports(host, 20) && <ProjectConfigs project={form} onChange={(ids) => set("claude_config_ids", ids)} />}
    </>
  );
}

/** The project's own pick of Claude configs, or its profile's. */
function ProjectConfigs({ project, onChange }: { project: Project; onChange: (ids: string[] | null) => void }) {
  const profile = useStore((s) => s.profiles.find((p) => p.host_id === project.host_id && p.id === project.profile_id));
  const label = useStore((s) => (profile ? profileConfigLabel(s, profile) : ""));
  const own = project.claude_config_ids != null;
  return (
    <div className="space-y-3 rounded-xl border border-line p-4">
      <div className="space-y-1.5">
        <Toggle
          checked={own}
          onChange={(v) => onChange(v ? (profile?.claude_config_ids ?? []) : null)}
          label="Use its own agent configs"
        />
        <div className="text-[12px] text-faint">
          {own ? "New tasks pick from these; with more than one, they ask which, starting with the default." : `Uses the profile's: ${label}.`}
        </div>
      </div>
      {own && <ConfigPicker hostId={project.host_id} value={project.claude_config_ids ?? []} onChange={onChange} />}
    </div>
  );
}

/** The project's own GitHub account, or its profile's. */
function ProjectGithubAccount({ project, onChange }: { project: Project; onChange: (account: string | null) => void }) {
  const profile = useStore((s) => s.profiles.find((p) => p.host_id === project.host_id && p.id === project.profile_id));
  return (
    <Field label="GitHub account" hint="The account its agents act as on GitHub through their gh tools. Overrides the profile's.">
      <GithubAccountSelect
        hostId={project.host_id}
        value={project.github_account ?? ""}
        onChange={(a) => onChange(a || null)}
        inherit={(active) => `Profile's (${profile?.github_account || (active ? `gh's active account, ${active}` : "gh's active account")})`}
      />
    </Field>
  );
}
