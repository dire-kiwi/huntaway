import { Plus, Trash2 } from "lucide-react";
import { effortOptions, inheritedModel, modelOptions, useAgentModels } from "../agents";
import { agentOf, type ClaudeConfig, type Reviewer } from "../api";
import { useStore } from "../store";
import { ModelPicker } from "./NewTaskModal";
import { Button, IconButton } from "./ui";

export const DEFAULT_REVIEWER: Reviewer = { claude_config_id: null, model: null, effort: null };
const MAX_REVIEWERS = 6;
const pickerClass = "h-7 rounded-md border border-line bg-panel px-1.5 text-[12.5px] text-fg outline-none";

/** The models a reviewer's blank model falls back to before the host's: the project's and the profile's. */
export interface InheritedModels {
  project?: string | null;
  profile?: string | null;
}

/** Whether `r` is the task's config with the default model and effort. */
export const isDefaultReviewer = (r: Reviewer | null | undefined) => !r || (!r.claude_config_id && !r.model && !r.effort);

/** Who a reviewer is, e.g. "Codex · gpt-5.1 · high effort". */
export function reviewerLabel(r: Reviewer, configs: ClaudeConfig[]): string {
  const config = r.claude_config_id ? (configs.find((c) => c.id === r.claude_config_id)?.name ?? "Deleted config (uses the task's)") : "The task's config";
  return [config, r.model ?? "default model", r.effort ? `${r.effort} effort` : "default effort"].join(" · ");
}

/** Reviewers, each in a review thread of its own; there's always at least one. */
export function ReviewerList({
  hostId,
  configs,
  models,
  value,
  onChange,
}: {
  hostId: string;
  configs: ClaudeConfig[];
  models: InheritedModels;
  value: Reviewer[];
  onChange: (v: Reviewer[]) => void;
}) {
  const list = value.length ? value : [DEFAULT_REVIEWER];
  const change = (i: number, r: Reviewer | null) => onChange(r ? list.map((x, j) => (j === i ? r : x)) : list.filter((_, j) => j !== i));
  return (
    <div className="space-y-2">
      {list.map((r, i) => (
        <ReviewerRow key={i} hostId={hostId} configs={configs} models={models} value={r} onChange={(v) => change(i, v)} removable={list.length > 1} />
      ))}
      {list.length < MAX_REVIEWERS && (
        <Button size="sm" variant="ghost" onClick={() => onChange([...list, DEFAULT_REVIEWER])}>
          <Plus size={12} /> Add reviewer
        </Button>
      )}
    </div>
  );
}

/** One reviewer (or the summarizer): its agent config, model and effort. */
export function ReviewerRow({
  hostId,
  configs,
  models: inherit,
  value,
  onChange,
  removable,
}: {
  hostId: string;
  configs: ClaudeConfig[];
  models: InheritedModels;
  value: Reviewer;
  onChange: (v: Reviewer | null) => void;
  removable: boolean;
}) {
  const config = configs.find((c) => c.id === value.claude_config_id);
  const models = useAgentModels(config);
  const hostSettings = useStore((s) => s.hostSettings[hostId]);
  const model = value.model ?? "";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        className={pickerClass}
        title="Agent config"
        value={value.claude_config_id ?? ""}
        // Another agent has other models.
        onChange={(e) => onChange({ claude_config_id: e.target.value || null, model: null, effort: null })}
      >
        <option value="">The task's config</option>
        {configs.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
            {agentOf(c) === "codex" ? " (Codex)" : ""}
          </option>
        ))}
        {value.claude_config_id && !config && <option value={value.claude_config_id}>Deleted config (uses the task's)</option>}
      </select>
      <ModelPicker
        value={model}
        onChange={(m) => onChange({ ...value, model: m || null })}
        options={modelOptions(config, models)}
        placeholder={agentOf(config) === "codex" ? "model id, e.g. gpt-6.1-sol" : undefined}
        inherited={inheritedModel(config, models, inherit.project, inherit.profile, hostSettings?.default_model)}
      />
      <select className={pickerClass} title="Effort" value={value.effort ?? ""} onChange={(e) => onChange({ ...value, effort: e.target.value || null })}>
        <option value="">{hostSettings?.default_effort ? `Default effort (${hostSettings.default_effort})` : "Default effort"}</option>
        {effortOptions(config, models, model).map((e) => (
          <option key={e} value={e}>
            {e} effort
          </option>
        ))}
        {value.effort && !effortOptions(config, models, model).includes(value.effort) && <option value={value.effort}>{value.effort} effort</option>}
      </select>
      {removable && (
        <IconButton title="Remove this reviewer" onClick={() => onChange(null)}>
          <Trash2 size={13} />
        </IconButton>
      )}
    </div>
  );
}

/** Whether a project's reviewers and summarizer are its own or its profile's: picks which, and shows the profile's. */
export function InheritPicker({
  own,
  onChange,
  what,
  profileHas,
}: {
  own: boolean;
  onChange: (own: boolean) => void;
  /** e.g. "reviewers" */
  what: string;
  /** What the profile's are, e.g. "The task's config · default model · default effort". */
  profileHas: string;
}) {
  return (
    <div className="space-y-1.5">
      <select className={pickerClass} title={`Whose ${what}`} value={own ? "own" : "profile"} onChange={(e) => onChange(e.target.value === "own")}>
        <option value="profile">The profile's {what}</option>
        <option value="own">This project's own {what}</option>
      </select>
      {!own && <div className="text-[12.5px] text-muted">{profileHas}</div>}
    </div>
  );
}
