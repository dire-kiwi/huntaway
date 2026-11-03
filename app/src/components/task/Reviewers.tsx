import clsx from "clsx";
import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { effortOptions, inheritedModel, modelOptions, useAgentModels } from "../../agents";
import { agentOf, api, hostSupports, REVIEWER_OPTIONS_API, type ClaudeConfig, type Reviewer } from "../../api";
import { useStore } from "../../store";
import { ModelPicker } from "../layout/newTask/ModelPicker";
import { Button, IconButton, Textarea } from "../ui";

export const DEFAULT_REVIEWER: Reviewer = { claude_config_id: null, model: null, effort: null };
const MAX_REVIEWERS = 6;
const pickerClass = "h-7 rounded-md border border-line bg-panel px-1.5 text-[12.5px] text-fg outline-none";

/** The models a reviewer's blank model falls back to before the host's: the project's and the profile's. */
export interface InheritedModels {
  project?: string | null;
  profile?: string | null;
}

/** Whether `r` is the task's config with the default model and effort, and no instructions or skills of its own. */
export const isDefaultReviewer = (r: Reviewer | null | undefined) => !r || (!r.claude_config_id && !r.model && !r.effort && !r.prompt?.trim() && !r.skills?.length);

/** A board skill a reviewer's thread can have on. */
export interface BoardSkill {
  name: string;
  description: string;
}

/** What a reviewer's instructions and skills are picked from, once the host takes them (API 103). */
export interface ReviewerExtras {
  /** The board's skills: the project's own and the global ones. */
  skills: BoardSkill[];
  /** What the instructions are without its own, shown in the field. */
  inherited: string;
  /** What the instructions are for, e.g. "What it looks for". */
  what: string;
}

/** The board's skills and the default instructions a reviewer (`kind` review) or the summarizer (`summary`) can be given its own of,
 * for a project's reviewers (`projectId`) or a profile's; null while they load or when the host can't take them. `inherited` is
 * what a reviewer without instructions of its own gets, if not the host's default. */
export function useReviewerExtras(hostId: string, kind: "review" | "summary", projectId?: string, inherited?: string | null): ReviewerExtras | null {
  const supported = useStore((s) => hostSupports(s.hosts.find((h) => h.id === hostId), REVIEWER_OPTIONS_API));
  const [loaded, setLoaded] = useState<{ skills: BoardSkill[]; defaults: string } | null>(null);
  useEffect(() => {
    if (!supported) return;
    let live = true;
    (async () => {
      const [defaults, skills] = await Promise.all([
        api.defaultPrompts(hostId),
        projectId
          ? api.agentTools(hostId, projectId).then((t) => [...t.skills, ...(t.global_skills ?? []).filter((s) => s.enabled)])
          : api.globalAgentTools(hostId).then((t) => t.skills.filter((s) => s.enabled)),
      ]);
      const seen = new Set<string>();
      const list = skills
        .filter((s) => !seen.has(s.name) && !!seen.add(s.name))
        .map((s) => ({ name: s.name, description: s.description }))
        .sort((a, b) => a.name.localeCompare(b.name));
      if (live) setLoaded({ skills: list, defaults: (kind === "summary" ? defaults.summary_prompt : defaults.review_prompt) ?? "" });
    })().catch(() => {});
    return () => {
      live = false;
    };
  }, [supported, hostId, projectId, kind]);
  if (!supported || !loaded) return null;
  return {
    skills: loaded.skills,
    inherited: kind === "review" && inherited?.trim() ? inherited : loaded.defaults,
    what: kind === "summary" ? "How it writes the summary" : "What it looks for",
  };
}

/** Who a reviewer is, e.g. "Codex · gpt-5.1 · high effort". */
export function reviewerLabel(r: Reviewer, configs: ClaudeConfig[]): string {
  const config = r.claude_config_id ? (configs.find((c) => c.id === r.claude_config_id)?.name ?? "Deleted config (uses the task's)") : "The task's config";
  const own = [r.prompt?.trim() ? "own instructions" : null, r.skills?.length ? `${r.skills.length} skill${r.skills.length === 1 ? "" : "s"}` : null];
  return [config, r.model ?? "default model", r.effort ? `${r.effort} effort` : "default effort", ...own].filter(Boolean).join(" · ");
}

/** Reviewers, each in a review thread of its own; there's always at least one. */
export function ReviewerList({
  hostId,
  configs,
  models,
  value,
  onChange,
  extras,
}: {
  hostId: string;
  configs: ClaudeConfig[];
  models: InheritedModels;
  value: Reviewer[];
  onChange: (v: Reviewer[]) => void;
  extras?: ReviewerExtras | null;
}) {
  const list = value.length ? value : [DEFAULT_REVIEWER];
  const change = (i: number, r: Reviewer | null) => onChange(r ? list.map((x, j) => (j === i ? r : x)) : list.filter((_, j) => j !== i));
  return (
    <div className="space-y-2">
      {list.map((r, i) => (
        <ReviewerRow key={i} hostId={hostId} configs={configs} models={models} value={r} onChange={(v) => change(i, v)} removable={list.length > 1} extras={extras} />
      ))}
      {list.length < MAX_REVIEWERS && (
        <Button size="sm" variant="ghost" onClick={() => onChange([...list, DEFAULT_REVIEWER])}>
          <Plus size={12} /> Add reviewer
        </Button>
      )}
    </div>
  );
}

/** One reviewer (or the summarizer): its agent config, model and effort, and with `extras` its own instructions and skills. */
export function ReviewerRow({
  hostId,
  configs,
  models: inherit,
  value,
  onChange,
  removable,
  extras,
}: {
  hostId: string;
  configs: ClaudeConfig[];
  models: InheritedModels;
  value: Reviewer;
  onChange: (v: Reviewer | null) => void;
  removable: boolean;
  extras?: ReviewerExtras | null;
}) {
  const [open, setOpen] = useState(false);
  const config = configs.find((c) => c.id === value.claude_config_id);
  const models = useAgentModels(config);
  const hostSettings = useStore((s) => s.hostSettings[hostId]);
  const model = value.model ?? "";
  const custom = !!value.prompt?.trim() || !!value.skills?.length;
  return (
    <div className="space-y-1.5">
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
        {extras && (
          <button
            type="button"
            className={clsx("flex h-7 items-center gap-0.5 rounded-md px-1.5 text-[12.5px] hover:text-fg", custom ? "text-accent" : "text-muted")}
          title={custom ? "It has instructions or skills of its own" : undefined}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            Instructions and skills
          </button>
        )}
        {removable && (
          <IconButton title="Remove this reviewer" onClick={() => onChange(null)}>
            <Trash2 size={13} />
          </IconButton>
        )}
      </div>
      {extras && open && <ReviewerOptions value={value} onChange={onChange} extras={extras} />}
    </div>
  );
}

/** A reviewer's own instructions, and the board skills on in its thread besides the project's. */
function ReviewerOptions({ value, onChange, extras }: { value: Reviewer; onChange: (v: Reviewer) => void; extras: ReviewerExtras }) {
  const on = value.skills ?? [];
  // A skill saved on the reviewer that was deleted since stays listed, so it can be taken off.
  const names = [...extras.skills.map((s) => s.name), ...on.filter((n) => !extras.skills.some((s) => s.name === n))];
  const describe = (n: string) => extras.skills.find((s) => s.name === n)?.description || "No longer on the board";
  return (
    <div className="space-y-2 rounded-md border border-line p-2">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted">{extras.what}</span>
          <span className="text-[11px] text-faint">{value.prompt?.trim() ? "Its own" : "The default"}</span>
          {!!value.prompt?.trim() && (
            <button type="button" className="ml-auto text-[12px] text-muted hover:text-fg" onClick={() => onChange({ ...value, prompt: null })}>
              Reset to default
            </button>
          )}
        </div>
        <Textarea
          rows={4}
          className="text-[12.5px]"
          aria-label={extras.what}
          value={value.prompt ?? extras.inherited}
          // The default text is no instructions of its own, so later changes to it apply.
          onChange={(e) => onChange({ ...value, prompt: e.target.value === extras.inherited ? null : e.target.value })}
        />
      </div>
      <div className="space-y-1">
        <span className="block text-xs font-medium text-muted">Skills on in its thread</span>
        {names.length === 0 ? (
          <span className="block text-xs text-faint">The board has no skills yet (Settings → Skills and MCP servers).</span>
        ) : (
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {names.map((n) => (
              <label key={n} className="flex items-center gap-1.5 text-[12.5px]" title={describe(n)}>
                <input
                  type="checkbox"
                  checked={on.includes(n)}
                  onChange={(e) => onChange({ ...value, skills: e.target.checked ? [...on, n] : on.filter((x) => x !== n) })}
                />
                {n}
              </label>
            ))}
          </div>
        )}
        <span className="block text-xs text-faint">On top of the skills the project has on. Its own change from the next review.</span>
      </div>
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
