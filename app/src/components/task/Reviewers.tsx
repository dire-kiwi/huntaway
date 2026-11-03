import { Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { effortOptions, inheritedModel, modelOptions, useAgentModels } from "../../agents";
import { agentOf, type ClaudeConfig, type Reviewer } from "../../api";
import { useStore } from "../../store";
import { ModelPicker } from "../layout/newTask/ModelPicker";
import { Button, IconButton, Input, Textarea } from "../ui";

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

/** Skill names as typed, separated by commas or spaces, with the `/` or `$` they're called with taken off. */
const parseSkills = (text: string) => [...new Set(text.split(/[\s,]+/).map((k) => k.replace(/^[/$]+/, "")).filter(Boolean))];

/** The most summarizers (the host's limit on reviewers). */
const MAX_SUMMARIZERS = 6;

/** Summarizers, each writing a summary in a thread of its own, so which skills and prompts summarise best can be compared; there's always at least one. */
export function SummarizerList({
  hostId,
  configs,
  models,
  value,
  onChange,
  skills,
}: {
  hostId: string;
  configs: ClaudeConfig[];
  models: InheritedModels;
  value: Reviewer[];
  onChange: (v: Reviewer[]) => void;
  /** Skills the project has, offered as the skills to pick from. */
  skills?: string[];
}) {
  const list = value.length ? value : [DEFAULT_REVIEWER];
  // Each row keeps its own draft and open prompt as others come and go, so rows are told apart by an id rather than their place.
  const ids = useRef<number[]>([]);
  const nextId = useRef(0);
  while (ids.current.length < list.length) ids.current.push(nextId.current++);
  ids.current.length = list.length;
  const change = (i: number, r: Reviewer | null) => {
    if (!r) ids.current.splice(i, 1);
    onChange(r ? list.map((x, j) => (j === i ? r : x)) : list.filter((_, j) => j !== i));
  };
  return (
    <div className="space-y-2.5">
      {list.map((r, i) => (
        <SummarizerRow
          key={ids.current[i]}
          hostId={hostId}
          configs={configs}
          models={models}
          value={r}
          onChange={(v) => change(i, v)}
          removable={list.length > 1}
          skills={skills}
        />
      ))}
      {list.length < MAX_SUMMARIZERS && (
        <Button size="sm" variant="ghost" onClick={() => onChange([...list, DEFAULT_REVIEWER])}>
          <Plus size={12} /> Add summarizer
        </Button>
      )}
    </div>
  );
}

/** One summarizer: its agent config, model and effort, a name, the skills it uses and a prompt of its own. */
function SummarizerRow({
  hostId,
  configs,
  models,
  value,
  onChange,
  removable,
  skills,
}: {
  hostId: string;
  configs: ClaudeConfig[];
  models: InheritedModels;
  value: Reviewer;
  onChange: (v: Reviewer | null) => void;
  removable: boolean;
  skills?: string[];
}) {
  const given = value.skills ?? [];
  // What's typed, which can end in a comma, until the skills change from elsewhere (a row removed above this one).
  const [draft, setDraft] = useState(given.join(", "));
  useEffect(() => setDraft((d) => (parseSkills(d).join(",") === given.join(",") ? d : given.join(", "))), [given.join(",")]);
  const [open, setOpen] = useState(!!value.prompt);
  const listId = `skills-${hostId}`;
  return (
    <div className="space-y-1.5 rounded-md border border-line p-2">
      <ReviewerRow hostId={hostId} configs={configs} models={models} value={value} onChange={onChange} removable={removable} />
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-40">
          <Input
            className="h-7 text-[12.5px]"
            title="What to call this summarizer where its summary is shown"
            placeholder="Name"
            value={value.name ?? ""}
            onChange={(e) => onChange({ ...value, name: e.target.value || null })}
          />
        </div>
        <div className="min-w-48 flex-1">
          <Input
            className="h-7 text-[12.5px]"
            title="Skills it uses while writing the summary, separated by commas"
            placeholder="Skills to use, e.g. tldr, changelog"
            list={skills?.length ? listId : undefined}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              onChange({ ...value, skills: parseSkills(e.target.value) });
            }}
          />
        </div>
        {skills?.length ? (
          <datalist id={listId}>
            {skills.map((k) => (
              <option key={k} value={k} />
            ))}
          </datalist>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>
          {open ? "Hide prompt" : value.prompt ? "Prompt" : "Add a prompt"}
        </Button>
      </div>
      {open && (
        <Textarea
          rows={4}
          className="text-[12.5px]"
          placeholder="How to write the summary. Replaces the board's instructions (what to cover, how long, its format); the board still asks it to end with only the summary."
          value={value.prompt ?? ""}
          onChange={(e) => onChange({ ...value, prompt: e.target.value || null })}
        />
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
        onChange={(e) => onChange({ ...value, claude_config_id: e.target.value || null, model: null, effort: null })}
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
