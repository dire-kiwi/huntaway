import clsx from "clsx";
import { Cpu, Folder, FolderGit2, Gauge, Layers, Link2, NotebookPen, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  agentOf,
  api,
  canRunAgents,
  hostSupports,
  isMerged,
  LABELS,
  LABELS_API,
  worktreesOn,
  type ClaudeConfig,
  type DocumentType,
  type Profile,
  type Project,
  type Effort,
  type ExternalLink,
  type Status,
  type Task,
  type TaskType,
  asanaLink,
} from "../api";
import { effortOptions, inheritedModel, isClaudeModel, modelOptions, useConfigsModels } from "../agents";
import { CODEX_MODEL_ALIASES, harnessesOf, harnessWords, newFanoutId, sameHarness, type Harness, type HarnessConfig, type HarnessWord } from "../harnesses";
import { allValues, completionAt, findTokens, insertCompletion, lastValue, placeWords, removeTokens, resolveTokens, stripTokens, type Token, type TokenPrefix, type Vocab } from "../taskTokens";
import { keyPrefix, useAvailableConfigs, useHost, useStore } from "../store";
import { ConfigSelect, ConfigUsageNote } from "./ClaudeConfigs";
import { withAttachments, type AttachmentRef } from "../attachments";
import { AttachButton, DraftAttachments, useAttachmentDraft } from "./Attachments";
import { AsanaIcon, AsanaPicker, LinkList, LINKS_API, usesAsana } from "./ExternalLinks";
import { documentInfo, LABEL_INFO, SCRATCH_TYPE } from "./Document";
import { Button, Input, Modal, ModalFooter, SUBMIT_KEYS, Toggle } from "./ui";



// The "Start agent now" choice is remembered per project on this client.
const startKey = (projectId: string) => `ia.startAgent.${projectId}`;
// Remembers the "Add another" toggle between dialogs.
const ADD_ANOTHER_KEY = "ia.newTask.addAnother";
// The model and effort last picked for a new task in a project, on this client. Blank (the
// default) leaves it to the project, profile and host settings.
const modelKey = (projectId: string) => `ia.newTask.model.${projectId}`;
const effortKey = (projectId: string) => `ia.newTask.effort.${projectId}`;
// The Claude config last picked, when the project offers more than one.
const configKey = (projectId: string) => `ia.newTask.claudeConfig.${projectId}`;
// The project last picked for a new task (or groupTarget, or scratchTarget).
export const PROJECT_KEY = "ia.newTask.project";
// What's been written for a new task and not yet created, so closing the dialog doesn't lose it.
// One per project, or per subproject for the dialog that adds to it.
const draftKey = (projectId: string, subprojectId?: string) => `ia.newTask.draft.${subprojectId ?? projectId}`;
// Stands in for a project id in the keys above for a group's group tasks, and for a profile's scratch tasks.
const groupTarget = (hostId: string, group: string) => `group:${hostId}:${group}`;
const scratchTarget = (p: Profile) => `scratch:${p.host_id}:${p.id}`;

interface Draft {
  description: string;
  /** Uploaded attachments, which are on the project's host. */
  files: AttachmentRef[];
  /** The Asana tasks picked for it, in the project's profile. */
  links?: ExternalLink[];
  /** Some of the tasks for its models were made, and these are the rest of the set (IA-227). */
  fanout?: PendingFanout | null;
}

/** A set of tasks from one prompt that only some of were made: what the rest are made with when it's tried again. */
interface PendingFanout {
  /** The id they share; null on hosts before API 61. */
  id: string | null;
  /** The keys of those made. */
  made: string[];
  /** The efforts those made took, so a `^` only they take is still one. */
  efforts: string[];
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isPendingFanout = (f: unknown): f is PendingFanout => {
  const x = f as PendingFanout | null;
  return !!x && (x.id === null || typeof x.id === "string") && strings(x.made) && strings(x.efforts);
};

const isLink = (l: unknown): l is ExternalLink => {
  const x = l as ExternalLink | null;
  return !!x && x.provider === "asana" && typeof x.id === "string" && typeof x.url === "string" && typeof x.title === "string";
};

function loadDraft(key: string): Draft | null {
  try {
    const d = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!d || typeof d.description !== "string") return null;
    return {
      description: d.description,
      files: Array.isArray(d.files) ? d.files : [],
      links: Array.isArray(d.links) ? d.links.filter(isLink) : [],
      fanout: isPendingFanout(d.fanout) ? d.fanout : null,
    };
  } catch {
    return null;
  }
}

const pickerClass = "h-7 rounded-md border border-line bg-panel px-1.5 text-[12.5px] text-fg outline-none";

/** The task's own model: blank for whatever the project, profile or host picks. */
export function ModelPicker({
  value,
  onChange,
  inherited,
  options,
  placeholder = "model id, e.g. claude-opus-5-5",
}: {
  value: string;
  onChange: (v: string) => void;
  inherited?: string | null;
  /** Claude's aliases, or a Codex config's models. */
  options: { id: string; label: string }[];
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <Input
        autoFocus
        value={value}
        placeholder={placeholder}
        className="h-7 w-52 font-mono text-[12px]"
        onChange={(e) => onChange(e.target.value.trim())}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          // Enter confirms the model rather than submitting the dialog.
          if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    );
  }
  return (
    <select
      className={pickerClass}
      title="Model"
      value={value}
      onChange={(e) => (e.target.value === "__custom" ? setEditing(true) : onChange(e.target.value))}
    >
      <option value="">{inherited ? `Default model (${inherited})` : "Default model"}</option>
      {options.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label}
        </option>
      ))}
      {value && !options.some((m) => m.id === value) && <option value={value}>{value}</option>}
      <option value="__custom">Specific model…</option>
    </select>
  );
}

/** What the new task dialog makes: code (null), a subproject or a scratch task. */
type NewTaskType = TaskType | "subproject" | null;

/** The labels, which `/` names too: `/plan /diagram` gives a task both. */
const LABEL_WORDS: string[] = LABELS;
const isLabelWord = (w: string | undefined): w is DocumentType => LABEL_WORDS.includes(w ?? "");

/** "a plan and a diagram". */
function labelList(labels: DocumentType[]) {
  const words = labels.map((l) => ({ plan: "a plan", artifact: "an artifact", diagram: "a diagram" })[l]);
  return words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}` : (words[0] ?? "");
}

/** A subproject, which the new task dialog offers as a type of task in a project that uses worktrees (API 17). */
const SUBPROJECT_TYPE = {
  id: "subproject" as const,
  label: "Subproject",
  icon: <Layers size={12} />,
  hint: "A task with its own worktree, thread and pull request, and a board of tasks that branch from its branch and merge back into it",
};

// The words `@` takes besides project keys: a group task, and a scratch task in no project. `!default` and `^default`
// leave the model and effort to the project, profile and host.
const GROUP_WORD = "group";
const NONE_WORD = "none";
const DEFAULT_WORD = "default";

/** `/type` names a type by its id, and a task (code) as `task`. */
const typeWord = (t: NewTaskType) => t ?? "task";

/** A value offered for a token as it's typed. */
type Suggestion = { value: string; label: string; hint?: string };

/** The token prefixes, in the order the legend and the placeholder give them. */
const TOKEN_HELP: { prefix: TokenPrefix; what: string; asks: string }[] = [
  { prefix: "/", what: "type or label", asks: "a type or label" },
  { prefix: "@", what: "where", asks: "where it goes" },
  { prefix: "!", what: "model", asks: "a model (or several, for a task each)" },
  { prefix: "^", what: "effort", asks: "effort" },
  { prefix: "#", what: "waits for", asks: "a task to wait for" },
];

// The editor's text and the highlighting behind it are laid out alike, so the highlights line up with what's typed.
const EDITOR_TEXT = "m-0 px-2.5 py-2 text-[13px] leading-[1.6] whitespace-pre-wrap break-words";

/** A value in the "Reads as" row: one a token set has an × that takes the token out; a dashed one is the default. */
function ReadsChip({ icon, label, title, onRemove, removeTitle = "Remove", dashed }: { icon?: ReactNode; label: ReactNode; title?: string; onRemove?: () => void; removeTitle?: string; dashed?: boolean }) {
  return (
    <span
      title={title}
      className={clsx(
        "inline-flex h-6 max-w-64 items-center gap-1 rounded-md border px-1.5 text-[12px]",
        dashed ? "border-dashed border-line-strong pr-2 text-faint" : "border-line bg-panel-2 text-fg",
      )}
    >
      {icon && <span className="shrink-0 text-accent">{icon}</span>}
      <span className="truncate">{label}</span>
      {onRemove && (
        <button type="button" className="-mr-0.5 shrink-0 rounded p-0.5 text-faint hover:bg-white/5 hover:text-fg" title={removeTitle} aria-label={removeTitle} onClick={onRemove}>
          <X size={11} />
        </button>
      )}
    </span>
  );
}

/**
 * The new task form. Its options are tokens typed in the description (IA-220): `/plan` its type, `@IA` where it goes
 * (or `@group`, `@none`), `!sonnet` its model (several make a task with each, IA-227), `^high` its effort and `#IA-212`
 * a task to merge first. They're taken
 * out of what its agent is given. With none, it goes where the dialog was opened, with the options last picked there.
 */
export function NewTaskModal({
  project: initial,
  projects,
  subproject,
  group: groupName,
  scratch,
  onClose,
  status = "todo",
}: {
  /** Where it goes. Without one, it can only be a scratch task (`scratch`). */
  project?: Project;
  /** Projects to pick from (`@` and their key), starting at `project`. Without them the task goes in `project`. */
  projects?: Project[];
  /** Add the task to this subproject. */
  subproject?: Task;
  /** The group `projects` are, which offers a group task too: one in no project that plans the group's work (API 34). */
  group?: string;
  /** The profile (on the host its scratch tasks go to) that offers a scratch task in no project too, with no repository (API 47). */
  scratch?: Profile | null;
  onClose: () => void;
  status?: Status;
}) {
  const hosts = useStore((s) => s.hosts);
  const initialHost = useHost(initial?.host_id);
  // A group task goes in the first project's profile and host, and remembers its options per group.
  const group = !!initial && !subproject && hostSupports(initialHost, 34) ? groupName : undefined;
  // Where it goes without an `@`: the project it's opened in, or no project or the group task, if that was last picked.
  // Once a task is created, where it went is where the next one starts (as it would in a new dialog).
  // It's kept by id, so it's the project as the board has it now (a refresh can find a repository became git's).
  const [base, setBase] = useState(() => ({
    projectId: initial?.id,
    noProject: !!scratch && (!initial || localStorage.getItem(PROJECT_KEY) === scratchTarget(scratch)),
    asGroup: !!group && !!initial && localStorage.getItem(PROJECT_KEY) === groupTarget(initial.host_id, group),
  }));
  const baseProject = (initial?.id === base.projectId ? initial : projects?.find((p) => p.id === base.projectId)) ?? initial;
  const basePref =
    base.noProject && scratch ? scratchTarget(scratch) : base.asGroup && group ? groupTarget(baseProject!.host_id, group) : baseProject!.id;
  // The draft is kept where the dialog starts, wherever its tokens send the task, so it comes back with them.
  const draft = draftKey(basePref, subproject?.id);
  const [saved] = useState(() => loadDraft(draft));
  const [description, setDescription] = useState(saved?.description ?? "");

  // The token being typed, to suggest values for: unless Escape closed the list for it, or the editor isn't focused.
  const input = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(description.length);
  const [focused, setFocused] = useState(true);
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const typing = focused ? completionAt(description, caret) : null;
  const completing = typing && typing.start !== closedAt ? typing : null;
  const found = useMemo(() => findTokens(description), [description]);

  // `@`: a project by its key (with its host or profile where that's ambiguous, or the key is `none` or `group`), the
  // group task or no project. A subproject's task stays in it.
  const profiles = useStore((s) => s.profiles);
  const placeNames = subproject
    ? []
    : placeWords(
        (projects ?? []).map((p) => ({
          key: p.key,
          host: hosts.find((h) => h.id === p.host_id)?.name ?? p.host_id,
          profile: profiles.find((x) => x.host_id === p.host_id && x.id === p.profile_id)?.name ?? p.profile_id,
        })),
        [GROUP_WORD, NONE_WORD],
      );
  const atVocab = subproject ? [] : [...placeNames, ...(group ? [GROUP_WORD] : []), ...(scratch ? [NONE_WORD] : [])];
  // An `@` being typed waits while it could still become another (`@S` of `@SD`), so the task doesn't go somewhere
  // else on the way (which can drop its files and Asana tasks); it's taken once it's picked, finished with a space or
  // left, and before Ctrl+Enter creates the task (see submit).
  const typed = completing?.prefix === "@" ? found.find((t) => t.start === completing.start) : undefined;
  const heldBack = typed && atVocab.some((v) => v.length > typed.word.length && v.toLowerCase().startsWith(typed.word.toLowerCase())) ? typed : undefined;
  const resolve = (vocab: Vocab) => resolveTokens(heldBack ? found.filter((t) => t !== heldBack) : found, vocab);
  // Meanwhile the task stays where the text last settled (also when the caret only moves into an `@` already taken,
  // or when the dialog opens with the caret after one), so nothing goes until the `@` being typed is done.
  const settledAt = useRef<{ at: string | undefined } | null>(null);
  if (!heldBack) settledAt.current = { at: lastValue(resolve({ "@": atVocab }), "@") };
  else settledAt.current ??= { at: lastValue(resolveTokens(found, { "@": atVocab }), "@") };
  const at = settledAt.current.at;
  const atProject = at === undefined ? undefined : projects?.[placeNames.indexOf(at)];
  const project = atProject ?? baseProject;
  // The project's host decides which types it offers, while the task is in no project too.
  const projectHost = useHost(project?.host_id);
  // What it is: code (null); a subproject, with its own board of tasks (API 17); or a scratch task, whose agent
  // works in its own folder on whatever it's asked (in no project, API 47, or in the project, API 51). Each is offered
  // where it can go. Labels come on top (see below).
  const canSubproject = !subproject && !!project && hostSupports(projectHost, 17) && worktreesOn(project);
  const projectScratch = !!project && hostSupports(projectHost, 51);
  // The types it can be, by the project's host (or the scratch task's, in no project).
  const typeTabs: { id: NewTaskType; label: string; icon: ReactNode; hint: string }[] = [
    ...(project ? [{ id: null, label: "Task", icon: <FolderGit2 size={12} />, hint: "Its agent works on the code" }] : []),
    ...(canSubproject ? [SUBPROJECT_TYPE] : []),
    ...(scratch || projectScratch ? [SCRATCH_TYPE] : []),
  ];
  const typeOf = (word: string | undefined) => typeTabs.find((t) => typeWord(t.id) === word);
  const typeAsked = typeOf(lastValue(resolve({ "/": typeTabs.map((t) => typeWord(t.id)) }), "/"))?.id;
  const asked = typeAsked !== undefined;
  // Without an `@`, a type keeps the task where it is, except that a scratch task starts out in no project when
  // that's offered, and another type in no project, or a scratch task or subproject in a group, goes in the project.
  let noProject = at === NONE_WORD;
  let asGroup = at === GROUP_WORD;
  if (!at) {
    noProject = base.noProject;
    asGroup = base.asGroup && !!group;
    if (asked && typeAsked === "scratch" && scratch && !noProject) [noProject, asGroup] = [true, false];
    else if (asked && noProject && typeAsked !== "scratch" && project) noProject = false;
    else if (asked && asGroup && (typeAsked === "scratch" || typeAsked === "subproject")) asGroup = false;
  }
  noProject = !!scratch && (noProject || !project);
  asGroup = asGroup && !noProject && !!group;
  // Where it goes: the project's host and profile, or the scratch task's in no project.
  const target = noProject ? { host_id: scratch!.host_id, profile_id: scratch!.id } : { host_id: project!.host_id, profile_id: project!.profile_id };
  const host = useHost(target.host_id);
  const prefId = noProject ? scratchTarget(scratch!) : asGroup ? groupTarget(target.host_id, group!) : project!.id;
  // The project it's in, if it's in one.
  const inProject = noProject || asGroup ? undefined : project;
  // The types it can be where it goes; one asked for that isn't falls back to the first that is.
  const offered: NewTaskType[] = noProject
    ? ["scratch"]
    : asGroup
      ? [null]
      : [null, ...(canSubproject ? ["subproject" as const] : []), ...(projectScratch ? ["scratch" as const] : [])];

  const agents = canRunAgents(host);
  const hostCount = hosts.length;
  const profile = useStore((s) => s.profiles.find((p) => p.host_id === target.host_id && p.id === target.profile_id));
  const hostSettings = useStore((s) => s.hostSettings[target.host_id]);
  // The model, effort and config last picked where it goes, which tokens override.
  const [model, setModel] = useState(() => localStorage.getItem(modelKey(prefId)) ?? "");
  const [effort, setEffort] = useState(() => (localStorage.getItem(effortKey(prefId)) ?? "") as Effort | "");
  const efforts = hostSupports(host, 14);
  // A group or scratch task isn't in the project, so the project's own configs don't apply to it.
  const configs = useAvailableConfigs(target.host_id, target.profile_id, inProject);
  // A subproject's tasks start out with its config.
  const [configPref, setConfigPref] = useState(() => subproject?.claude_config_id ?? localStorage.getItem(configKey(prefId)) ?? "");
  const config = configs.some((c) => c.id === configPref) ? configPref : (configs[0]?.id ?? "");
  const pickConfig = configs.length > 1;
  const configObj = configs.find((c) => c.id === config);
  const codex = agentOf(configObj) === "codex";
  // Every config's models, as a `!` can send the task to any of them (IA-227).
  const discovery = useConfigsModels(configs);
  const configModels = discovery.models;
  const models = configObj ? configModels[configObj.id] : null;
  const modelList = modelOptions(configObj, models);
  // Models and efforts are the agent's own, so picking another agent starts them over.
  const setConfig = (id: string) => {
    if (agentOf(configs.find((c) => c.id === id)) !== agentOf(configObj)) {
      setModel("");
      setEffort("");
    }
    setConfigPref(id);
  };

  // Tasks to merge before its agent starts (API 24), as `#` and their key.
  const preTokens = resolve({ "/": offered.map(typeWord) });
  const typeTab = typeOf(lastValue(preTokens, "/"));
  const taskType: NewTaskType = typeTab ? typeTab.id : offered[0];
  const deps = hostSupports(host, 24) && !!inProject && taskType !== "scratch";
  const depProject = deps ? inProject : undefined;
  const depTasks = useStore(
    useShallow((s) =>
      depProject
        ? Object.values(s.tasks)
            .filter((t) => t.kind === "task" && t.project_id === depProject.id && !isMerged(t))
            .sort((a, b) => b.number - a.number)
        : [],
    ),
  );
  const depKey = (t: Task) => `${depProject?.key}-${t.number}`;

  // What `!` names: a model of any of the configs, or one's default model (see harnesses.ts). With no configs to pick
  // from, Claude's own config.
  const harnessConfigs: HarnessConfig[] = configs.length
    ? configs.map((c) => ({ id: c.id, name: c.name, agent: agentOf(c), models: modelOptions(c, configModels[c.id]) }))
    : [{ id: "", name: "", agent: "claude", models: modelList }];
  // Claude takes a full model id too (what "Specific model…" was for), in the picked config or the first Claude one.
  const claudeConfig = harnessConfigs.find((c) => c.id === config && c.agent === "claude") ?? harnessConfigs.find((c) => c.agent === "claude");
  const specific: HarnessWord[] = claudeConfig
    ? found
        .filter((t) => t.prefix === "!" && /^claude-[\w.-]+$/i.test(t.word))
        .map((t) => ({ word: t.word.toLowerCase(), harness: { config: claudeConfig.id, model: t.word.toLowerCase() }, label: t.word.toLowerCase() }))
    : [];
  const harnessVocab = [...harnessWords(harnessConfigs, config, DEFAULT_WORD), ...specific];
  const modelVocab = harnessVocab.map((w) => w.word);
  // A task for each harness named (`!opus !gpt-5.5` makes two from one prompt); with none, one in the picked config
  // with the model last picked there.
  const named = harnessesOf(harnessVocab, allValues(resolve({ "!": modelVocab }), "!"));
  const runs: Harness[] = named.length ? named : [{ config, model: codex && isClaudeModel(model) ? "" : model }];
  // Several harnesses make a task each. After only some of them could be made, those left (even one) are made as part
  // of the same set when it's tried again: linked to the others by its id (null on hosts before API 61), in a worktree.
  // Kept with the draft, so closing the dialog (or reloading) before trying again doesn't lose it.
  const [pending, setPending] = useState<PendingFanout | null>(() => saved?.fanout ?? null);
  // Taking all the text out starts over.
  useEffect(() => {
    if (!description.trim()) setPending(null);
  }, [description]);
  const many = runs.length > 1;
  const fanout = many || pending !== null;
  const runConfig = (h: Harness) => configs.find((c) => c.id === h.config);
  // The efforts any of them takes; one that doesn't take the effort picked gets its default.
  // The model one on its default model runs with: the project's, profile's or host's (as runner::launch picks it), else its agent's.
  const runInherits = (h: Harness) => inheritedModel(runConfig(h), configModels[h.config] ?? null, inProject?.model, profile?.default_model, hostSettings?.default_model);
  const runEfforts = (h: Harness) => effortOptions(runConfig(h), configModels[h.config] ?? null, h.model || runInherits(h) || "");
  // Those of the tasks already made too, so a `^` that only they take is still read as one when the rest are made.
  const effortList = efforts ? [...new Set([...runs.flatMap(runEfforts), ...(pending?.efforts ?? [])])] : [];
  const harnessOf = (word: string | undefined) => harnessVocab.find((w) => w.word === word)?.harness;
  // A harness as the "Reads as" row has it: its model (or the one it inherits), and its config where there are several.
  const runLabel = (h: Harness) => {
    const c = harnessConfigs.find((x) => x.id === h.config);
    const inherits = h.model ? undefined : runInherits(h);
    const m = h.model ? (c?.models.find((x) => x.id === h.model)?.label ?? h.model) : inherits ? `default model (${inherits})` : "default model";
    return pickConfig && c ? `${m} · ${c.name}` : m;
  };
  // Labels, each a document its agent writes besides its other work, shown in a tab of the task (API 71). A host from
  // API 42 makes a task of one of them as its type instead (a plan, artifact or diagram task), which is a code task in
  // a project or a group task, and makes only the document.
  const labelling = hostSupports(host, LABELS_API);
  const labelTypes = !labelling && hostSupports(host, 42) && !noProject && taskType === null;
  const labelWords = labelling || labelTypes ? LABEL_WORDS : [];
  const tokens = resolve({
    "@": atVocab,
    "/": [...offered.map(typeWord), ...labelWords],
    "!": modelVocab,
    ...(efforts ? { "^": [DEFAULT_WORD, ...effortList] } : {}),
    ...(deps ? { "#": depTasks.map(depKey) } : {}),
  });
  const effortAsked = lastValue(tokens, "^");
  const pickedEffort = (effortAsked === undefined ? effort : effortAsked === DEFAULT_WORD ? "" : effortAsked) as Effort | "";
  const dependsOn = allValues(tokens, "#").flatMap((k) => depTasks.filter((t) => depKey(t) === k).map((t) => t.id));
  // What its agent is given: the description without its tokens.
  const text = stripTokens(description, tokens);

  const labels = LABELS.filter((l) => allValues(tokens, "/").includes(l));
  // On a host before API 71, the label it's made as (one at most).
  const docType = labelTypes ? (labels[0] ?? null) : null;
  // A subproject's branch is what its tasks branch from, so it and they get worktrees.
  const asSubproject = taskType === "subproject";
  const codeTask = (taskType === null && !docType) || asSubproject;
  const noun = taskType === "scratch" ? "scratch task" : asGroup && !docType ? "group task" : (docType ?? taskType ?? "task");

  const attach = useAttachmentDraft(target.host_id, hostSupports(host, 18), saved?.files);
  // The Asana tasks it's for (API 57), in the profile it goes in, unless that has Asana turned off.
  const linking = hostSupports(host, LINKS_API) && usesAsana(profile);
  const [links, setLinks] = useState<ExternalLink[]>(saved?.links ?? []);
  const [pickingLink, setPickingLink] = useState(false);
  const hasContent = !!text.trim() || attach.items.length > 0;
  // Saved as it's written, tokens and all (and when it's only tokens, the options they pick). Files still uploading are left out until they're on the host.
  const draftJson =
    description.trim() || attach.files.length || links.length || pending
      ? JSON.stringify({ description, files: attach.files, links, ...(pending ? { fanout: pending } : {}) } satisfies Draft)
      : null;
  useEffect(() => {
    if (draftJson) localStorage.setItem(draft, draftJson);
    else localStorage.removeItem(draft);
  }, [draft, draftJson]);
  // Whether the repo is a git repository can have changed since the board loaded the project
  // (an agent may have run `git init`), and it decides whether new tasks get a worktree.
  useEffect(() => {
    if (!project) return;
    api
      .getProject(project.host_id, project.id)
      .then((p) => useStore.getState().upsertProject({ ...p, host_id: project.host_id }))
      .catch(() => {});
  }, [project?.host_id, project?.id]);
  // Follows the project until it's changed here.
  const [worktreeChoice, setWorktree] = useState<boolean | null>(null);
  const worktreePref = worktreeChoice ?? (!!inProject && worktreesOn(inProject));
  // Tasks made from one prompt each get a worktree too, so their agents don't change the same checkout (as in t3code).
  const worktree = !!inProject && codeTask && (worktreePref || fanout || asSubproject || !!subproject);
  // What can't be made a task for each of several harnesses. A group task coordinates its group's work, so it takes one,
  // unless it has labels: then they write documents to compare.
  const fanoutBlock = !fanout
    ? null
    : asSubproject
      ? "A subproject has one agent, so it takes one model."
      : asGroup && !docType && !labels.length
        ? "A group task has one agent, so it takes one model."
        : worktree && inProject?.is_git === false
          ? `${inProject.name} isn't a git repository, so its tasks can't each have their own worktree: pick one model, or make it a scratch task.`
          : null;
  // A host before API 71 makes a task of one label's type.
  const labelBlock = labelTypes && labels.length > 1 ? `${host?.name ?? "This host"} makes a task of one of plan, artifact or diagram, not several: update it for labels.` : null;
  // What a Codex config's models say waits for them: which model a `!` that names none yet is (so a harness isn't left
  // out, with its token sent as text); which config a `!` names a model of, when a config of the same agent before it
  // (the picked one, then in order) may have the model too (so it doesn't depend on which answers first); and whether the effort picked
  // is one a Codex harness's model takes (it's only sent if it is). If they couldn't be fetched, it says so.
  const unknownModels = tokens.filter((t) => t.prefix === "!" && t.value === undefined);
  const asText = unknownModels.map((t) => `!${t.word}`).join(", ");
  const rank = (id: string) => (id === config ? -1 : configs.findIndex((c) => c.id === id));
  const claimable = (c: ClaudeConfig) =>
    tokens.filter((t) => {
      const w = t.prefix === "!" && t.value !== undefined ? harnessVocab.find((x) => x.word === t.value) : undefined;
      const agent = harnessConfigs.find((x) => x.id === w?.harness.config)?.agent;
      const plain = w && (w.word.toLowerCase() === w.harness.model.toLowerCase() || CODEX_MODEL_ALIASES.includes(w.word));
      return !!w && !!w.harness.model && plain && agent === agentOf(c) && rank(c.id) < rank(w.harness.config);
    });
  const effortWaits = (c: ClaudeConfig) => efforts && !!pickedEffort && runs.some((h) => h.config === c.id);
  const waitsFor = (c: ClaudeConfig) => unknownModels.length > 0 || claimable(c).length > 0 || effortWaits(c);
  const loadingFor = discovery.loading.filter(waitsFor);
  const failedFor = discovery.failed.filter((f) => waitsFor(f.config));
  const configNames = (cs: { name: string }[]) => cs.map((c) => c.name).join(", ");
  const claimed = (cs: ClaudeConfig[]) => [...new Set(cs.flatMap((c) => claimable(c).map((t) => `!${t.word}`)))].join(", ");
  // The words that name the config a model is taken from, for a model another config may have too.
  const qualified = (cs: ClaudeConfig[]) =>
    cs
      .flatMap((c) => claimable(c))
      .flatMap((t) => {
        const h = harnessOf(t.value);
        const w = h && harnessVocab.find((x) => sameHarness(x.harness, h) && x.word.toLowerCase() !== h.model.toLowerCase());
        return w ? [`!${w.word}`] : [];
      })
      .filter((w, i, all) => all.indexOf(w) === i)
      .join(", ");
  const unknown = (cs: ClaudeConfig[]) =>
    unknownModels.length
      ? `which ${asText} is`
      : claimed(cs)
        ? `whether ${cs.length > 1 ? "they have" : "it has"} ${claimed(cs)} too`
        : `whether ${cs.length > 1 ? "they take" : "it takes"} ${pickedEffort} effort`;
  const takeOut = (cs: ClaudeConfig[]) =>
    unknownModels.length ? "it out" : claimed(cs) ? `${claimed(cs)} out, or name its config (${qualified(cs)})` : "the effort out";
  const modelsLoading = loadingFor.length > 0;
  const modelsBlock = modelsLoading
    ? `Loading ${configNames(loadingFor)}'s models, to see ${unknown(loadingFor)}…`
    : failedFor.length
      ? `Couldn't load ${configNames(failedFor.map((f) => f.config))}'s models (${failedFor[0].error}), so there's no telling ${unknown(failedFor.map((f) => f.config))}: take ${takeOut(failedFor.map((f) => f.config))}, or open the dialog again to try again.`
      : null;
  // While they're loading, creating it waits for them (see whenLoaded).
  const submitBlock = labelBlock ?? fanoutBlock ?? (modelsLoading ? null : modelsBlock);
  const [startPref, setStartPref] = useState(() => localStorage.getItem(startKey(prefId)) === "1");
  const start = agents && startPref;
  const setStart = (v: boolean) => {
    setStartPref(v);
    localStorage.setItem(startKey(prefId), v ? "1" : "0");
  };
  const [addAnother, setAddAnother] = useState(() => localStorage.getItem(ADD_ANOTHER_KEY) === "1");
  const changeAddAnother = (v: boolean) => {
    setAddAnother(v);
    localStorage.setItem(ADD_ANOTHER_KEY, v ? "1" : "0");
  };
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // The last task created while "Add another" is on, so there's feedback that it went through (its key as it was made,
  // as the dialog may have moved since).
  const [created, setCreated] = useState<{ key: string; title: string } | null>(null);

  // Somewhere else (by an `@`, or a type that goes elsewhere) brings its own remembered options. Asana tasks go along
  // within the profile, which is where they were found, and files uploaded to another host would be lost.
  const was = useRef({ prefId, ...target });
  const switched = useRef(false);
  useEffect(() => {
    const from = was.current;
    if (from.prefId === prefId) return;
    was.current = { prefId, ...target };
    setModel(localStorage.getItem(modelKey(prefId)) ?? "");
    setEffort((localStorage.getItem(effortKey(prefId)) ?? "") as Effort | "");
    setConfigPref(localStorage.getItem(configKey(prefId)) ?? "");
    setStartPref(localStorage.getItem(startKey(prefId)) === "1");
    setWorktree(null);
    setCreated(null);
    setPending(null);
    switched.current = true;
    if (from.host_id !== target.host_id || from.profile_id !== target.profile_id) setLinks([]);
    if (from.host_id !== target.host_id) attach.clear();
  }, [prefId, target.host_id, target.profile_id]); // eslint-disable-line react-hooks/exhaustive-deps
  // A draft brought back (by Add another) has its files and Asana tasks where its own tokens send it, so they're put
  // back after the move there above has dropped those of where the dialog was.
  // So is the note of the task just created, which the move drops.
  const [restoring, setRestoring] = useState<{ draft: Draft; made: { key: string; title: string } } | null>(null);
  useEffect(() => {
    if (!restoring) return;
    const { draft: theirs, made } = restoring;
    setRestoring(null);
    attach.clear();
    setLinks(theirs.links ?? []);
    setPending(theirs.fanout ?? null);
    if (attach.enabled) attach.restore(theirs.files);
    setCreated(made);
  }, [restoring]); // eslint-disable-line react-hooks/exhaustive-deps

  // Where the caret goes once a change to the text is drawn: at first, after a draft that comes back.
  const caretTo = useRef<number | null>(description.length);
  const edit = (next: string, at: number) => {
    setDescription(next);
    setCaret(at);
    setClosedAt(null);
    caretTo.current = at;
  };
  useLayoutEffect(() => {
    if (caretTo.current === null || !input.current) return;
    input.current.focus();
    input.current.setSelectionRange(caretTo.current, caretTo.current);
    caretTo.current = null;
  }, [description]);
  // Takes tokens out of the text (the "Reads as" row's ×).
  const untoken = (which: (t: Token) => boolean) => {
    const gone = tokens.filter((t) => t.value !== undefined && which(t));
    const next = removeTokens(description, gone);
    edit(next, Math.min(next.length, Math.max(0, caret - gone.filter((t) => t.end <= caret).reduce((n, t) => n + t.end - t.start, 0))));
  };
  // A legend's prefix, typed at the caret, to pick its value from the list.
  const typePrefix = (prefix: TokenPrefix) => {
    const space = caret > 0 && !/\s/.test(description[caret - 1]) ? " " : "";
    edit(description.slice(0, caret) + space + prefix + description.slice(caret), caret + space.length + 1);
  };

  // Ctrl+Enter in an `@` being typed takes it as it is first (and what it brings, from the next render on), so what's
  // created is what the text says.
  const [settling, setSettling] = useState(0);
  const submit = async () => {
    if (heldBack) {
      setClosedAt(heldBack.start);
      setSettling(1);
      return;
    }
    if (!hasContent || busy || attach.uploading || submitBlock) return;
    if (modelsLoading) return setWhenLoaded(true);
    setBusy(true);
    setErr(null);
    // A task for each harness, one after another, so a failure leaves the rest to try again.
    const tasks: Task[] = [];
    const fanoutId = pending ? pending.id : fanout && hostSupports(host, 61) ? newFanoutId() : null;
    const shared = fanoutId ? { fanout_id: fanoutId } : {};
    try {
      for (const run of runs) {
        // The server titles it from the description.
        const runEffort = efforts && pickedEffort && runEfforts(run).includes(pickedEffort) ? pickedEffort : undefined;
        const common = {
          ...(labelling && labels.length ? { labels } : {}),
          description: withAttachments(text, attach.files),
          start,
          status,
          model: run.model || undefined,
          effort: runEffort,
          ...(pickConfig ? { claude_config_id: run.config } : {}),
          ...(linking && links.length ? { external_links: links } : {}),
        };
        try {
          tasks.push(
            noProject
              ? await api.createScratchTask(target.host_id, target.profile_id, { ...common, ...shared })
              : asGroup && group
                ? await api.createGroupTask(target.host_id, target.profile_id, { ...common, ...shared, group, ...(docType ? { task_type: docType } : {}) })
                : await api.createTask(project!.host_id, project!.id, {
                    ...common,
                    ...shared,
                    use_worktree: worktree,
                    ...(subproject ? { parent_id: subproject.id } : {}),
                    // Sent as the flag, which hosts before API 51 take too.
                    ...(asSubproject ? { subproject: true } : taskType ? { task_type: taskType } : docType ? { task_type: docType } : {}),
                    ...(deps && dependsOn.length ? { depends_on: dependsOn } : {}),
                  }),
          );
        } catch (e) {
          if (!tasks.length) throw e;
          // Those made are taken out of the text, so trying again makes the others.
          const done = runs.slice(0, tasks.length);
          untoken((t) => t.prefix === "!" && done.some((h) => sameHarness(harnessOf(t.value), h)));
          const keys = tasks.map((t) => `${keyPrefix(t, inProject)}-${t.number}`);
          setPending({ id: fanoutId, made: [...(pending?.made ?? []), ...keys], efforts: effortList });
          setErr(`Made ${keys.join(", ")}, but not the one with ${runLabel(run)}: ${(e as Error).message}`);
          setBusy(false);
          return;
        }
      }
      setPending(null);
      // One harness is what's picked from then on; several (or what's left of them) leave what was picked as it was.
      const only = fanout ? null : runs[0];
      if (only) {
        const m = named.length ? only.model : model;
        setModel(m);
        localStorage.setItem(modelKey(prefId), m);
        if (only.config !== config) setConfigPref(only.config);
        if (pickConfig) localStorage.setItem(configKey(prefId), only.config);
      }
      setEffort(pickedEffort);
      if (efforts) localStorage.setItem(effortKey(prefId), pickedEffort);
      // Where it went is where the next one starts, where there's a choice.
      if (projects?.length) localStorage.setItem(PROJECT_KEY, prefId);
      localStorage.removeItem(draft);
      if (!addAnother) return onClose();
      const made = { key: tasks.map((t) => `${keyPrefix(t, inProject)}-${t.number}`).join(", "), title: tasks[0].title };
      setCreated(made);
      // The dialog starts there now too, as it would opened again, so the next one's draft is kept there. A draft
      // already there comes back, rather than being written over.
      const there = projects?.length ? draftKey(prefId, subproject?.id) : draft;
      const theirs = there !== draft ? loadDraft(there) : null;
      if (projects?.length) setBase({ projectId: project?.id, noProject, asGroup });
      attach.clear();
      if (theirs) {
        edit(theirs.description, theirs.description.length);
        setRestoring({ draft: theirs, made });
      } else {
        // Or it keeps the same options (its tokens) for the next one.
        const kept = tokens.flatMap((t) => (t.value !== undefined ? [description.slice(t.start, t.end)] : [])).join(" ");
        edit(kept && `${kept} `, kept ? kept.length + 1 : 0);
        setLinks([]);
      }
      setBusy(false);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  // Created once the models it waits for are in, if it was asked for meanwhile (and the text hasn't changed since).
  const [whenLoaded, setWhenLoaded] = useState(false);
  useEffect(() => setWhenLoaded(false), [description]);
  useEffect(() => {
    if (!whenLoaded || modelsLoading) return;
    setWhenLoaded(false);
    submit();
  }, [whenLoaded, modelsLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  // What's offered for each prefix as it's typed.
  const inherited = inheritedModel(configObj, models, inProject?.model, profile?.default_model, hostSettings?.default_model);
  useEffect(() => {
    const justSwitched = switched.current;
    switched.current = false;
    if (!settling) return;
    // Somewhere else's remembered options are only in place after another render.
    if (justSwitched) return setSettling((n) => n + 1);
    setSettling(0);
    submit();
  });
  const suggestions: Record<TokenPrefix, Suggestion[]> = {
    "/": [
      ...typeTabs.map((t) => ({ value: typeWord(t.id), label: t.label, hint: t.hint })),
      ...LABEL_INFO.filter((l) => labelWords.includes(l.id)).map((l) => ({ value: l.id, label: labelling ? `${l.label} label` : l.label, hint: l.hint })),
    ],
    "@": subproject
      ? []
      : [
          ...(projects ?? []).map((p, i) => ({ value: placeNames[i], label: p.name, hint: hostCount > 1 ? hosts.find((h) => h.id === p.host_id)?.name : undefined })),
          ...(group ? [{ value: GROUP_WORD, label: `Group task (${group})`, hint: "Plans the work across the group's projects" }] : []),
          ...(scratch ? [{ value: NONE_WORD, label: `No project (${scratch.name})`, hint: "A scratch task, with no repository" }] : []),
        ],
    // Each `!` makes a task with its model, so naming several makes a task for each (IA-227).
    "!": harnessVocab
      .filter((w) => !specific.includes(w))
      .map((w) => ({
        value: w.word,
        label: w.word === DEFAULT_WORD && !pickConfig ? (inherited ? `Default model (${inherited})` : "Default model") : w.label,
        hint: named.length ? "Another ! makes another task from this prompt, with that model" : undefined,
      })),
    "^": efforts
      ? [
          { value: DEFAULT_WORD, label: hostSettings?.default_effort ? `Default effort (${hostSettings.default_effort})` : "Default effort" },
          ...effortList.map((e) => ({ value: e, label: `${e} effort` })),
        ]
      : [],
    "#": depTasks.map((t) => ({ value: depKey(t), label: t.title })),
  };
  // The one that's what's typed comes first, then those starting with it, then those whose name has it.
  const query = completing?.query.toLowerCase() ?? "";
  const matches = completing
    ? [
        ...suggestions[completing.prefix].filter((s) => s.value.toLowerCase() === query),
        ...suggestions[completing.prefix].filter((s) => s.value.toLowerCase() !== query && s.value.toLowerCase().startsWith(query)),
        ...(query ? suggestions[completing.prefix].filter((s) => !s.value.toLowerCase().startsWith(query) && s.label.toLowerCase().includes(query)) : []),
      ].slice(0, 8)
    : [];
  const listOpen = !!completing && matches.length > 0;
  const [hl, setHl] = useState(0);
  const lit = Math.min(hl, matches.length - 1);
  const pick = (s: Suggestion) => {
    if (!completing) return;
    const r = insertCompletion(description, completing, completing.prefix, s.value);
    edit(r.text, r.caret);
  };

  // The highlighting behind the editor, sized to its text area (without a scrollbar) and scrolled with it.
  const mirror = useRef<HTMLDivElement>(null);
  const marker = useRef<HTMLSpanElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(0);
  useLayoutEffect(() => {
    const ta = input.current;
    const m = mirror.current;
    if (!ta || !m) return;
    const fit = () => {
      m.style.width = `${ta.clientWidth}px`;
      m.style.height = `${ta.clientHeight}px`;
      m.scrollTop = ta.scrollTop;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(ta);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    const ta = input.current;
    const m = mirror.current;
    if (m && ta) m.scrollTop = ta.scrollTop;
  }, [listOpen, completing?.start, description, scrolled]);
  // The completion list is fixed to the window (the dialog's body scrolls, and would clip it): under the caret, or over
  // it when there's more room there, no taller than that room, and moved with the caret as the dialog scrolls.
  useLayoutEffect(() => {
    if (!listOpen) return;
    const place = (rendered = false) => {
      const k = marker.current;
      const ta = input.current;
      const l = list.current;
      if (!k || !ta || !l) return;
      const at = k.getBoundingClientRect();
      const box = ta.getBoundingClientRect();
      const below = window.innerHeight - at.bottom - 10;
      const above = at.top - 10;
      const up = l.scrollHeight > below && above > below;
      l.style.maxHeight = `${Math.max(80, up ? above : below)}px`;
      l.style.top = `${up ? Math.max(8, at.top - 2 - l.offsetHeight) : at.bottom + 2}px`;
      l.style.left = `${Math.max(box.left, Math.min(at.left, box.left + ta.clientWidth - l.offsetWidth))}px`;
      if (!rendered) return;
      // Keeps the highlighted option in view when the list scrolls (not while the wheel scrolls it).
      const lit = l.querySelector<HTMLElement>("[aria-selected=true]");
      if (lit && lit.offsetTop < l.scrollTop) l.scrollTop = lit.offsetTop;
      else if (lit && lit.offsetTop + lit.offsetHeight > l.scrollTop + l.clientHeight) l.scrollTop = lit.offsetTop + lit.offsetHeight - l.clientHeight;
    };
    place(true);
    const move = () => place();
    window.addEventListener("scroll", move, true);
    window.addEventListener("resize", move);
    return () => {
      window.removeEventListener("scroll", move, true);
      window.removeEventListener("resize", move);
    };
  });
  const highlighted: ReactNode[] = [];
  {
    let at = 0;
    const marks = [...found.map((t) => ({ at: t.start, token: t })), ...(listOpen ? [{ at: completing!.start, token: null }] : [])].sort((a, b) => a.at - b.at || (a.token ? 1 : -1));
    for (const { token: t, at: s } of marks) {
      highlighted.push(description.slice(at, s));
      if (!t) {
        highlighted.push(<span key="caret" ref={marker} />);
        at = s;
        continue;
      }
      const known = tokens.find((x) => x.start === t.start);
      // The token being typed isn't marked until it's settled.
      const settled = !!known;
      highlighted.push(
        <span
          key={t.start}
          className={clsx(
            settled && "rounded-[3px]",
            known?.value !== undefined ? "bg-accent/20 text-[#c8c8ff] ring-1 ring-accent/30" : settled && "bg-amber-500/10 text-amber-300 ring-1 ring-amber-500/30",
          )}
        >
          {description.slice(t.start, t.end)}
        </span>,
      );
      at = t.end;
    }
    highlighted.push(description.slice(at));
  }

  // The prefixes that can set something here, for the legend and the placeholder, with an example of each.
  const example: Partial<Record<TokenPrefix, string>> = {
    ...(labelWords.length ? { "/": "plan" } : typeTabs.length > 1 ? { "/": typeWord(typeTabs.find((t) => t.id !== offered[0])?.id ?? null) } : {}),
    ...(atVocab.length ? { "@": placeNames[(projects ?? []).findIndex((p) => p.id !== project?.id)] ?? atVocab[0] } : {}),
    "!": modelList[0]?.id ?? DEFAULT_WORD,
    ...(efforts ? { "^": effortList.includes("high") ? "high" : (effortList[0] ?? DEFAULT_WORD) } : {}),
    ...(deps ? { "#": depTasks[0] ? depKey(depTasks[0]) : `${depProject!.key}-1` } : {}),
  };
  const help = TOKEN_HELP.filter((h) => example[h.prefix]);
  const tokenHint = `Type ${help.map((h, i) => `${i === help.length - 1 && i > 0 ? "or " : ""}${h.prefix} for ${h.asks}`).join(", ")}.`;

  // What the tokens set, and what a token set (its × takes it out).
  const setBy = (prefix: TokenPrefix) => tokens.some((t) => t.prefix === prefix && t.value !== undefined);
  const removeKind = (prefix: TokenPrefix) => () => untoken((t) => t.prefix === prefix && !(prefix === "/" && isLabelWord(t.value)));
  const typeSet = tokens.some((t) => t.prefix === "/" && t.value !== undefined && !isLabelWord(t.value));
  const typeInfo = typeTabs.find((t) => t.id === taskType);
  const modelLabel = (m: string) => modelList.find((x) => x.id === m)?.label ?? m;
  const where = subproject
    ? `${project!.key}-${subproject.number} ${subproject.title}`
    : noProject
      ? scratch!.name
      : asGroup
        ? docType ? `the ${group} group` : group
        : `${project!.name}${hostCount > 1 && projects?.some((p) => p.host_id !== project!.host_id) ? ` (${host?.name})` : ""}`;

  return (
    <Modal
      title={
        <span>
          New {noun} <span className="font-normal text-muted">{asGroup ? "for" : "in"} {where}</span>
        </span>
      }
      onClose={onClose}
      // Not while the Asana dialog is open over it, whose Enter (with Ctrl or Cmd too) is its own.
      onSubmit={pickingLink ? undefined : submit}
      width="max-w-xl"
    >
      <form
        className="space-y-3"
        {...attach.dropProps}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div
          className={clsx(
            "relative rounded-md border border-line bg-panel focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/15",
            attach.dragging && "border-accent/60 bg-accent/5",
          )}
        >
          <div ref={mirror} aria-hidden className={clsx(EDITOR_TEXT, "pointer-events-none absolute top-0 left-0 overflow-hidden text-fg")}>
            {highlighted}
            {"\n"}
          </div>
          <textarea
            ref={input}
            autoFocus
            rows={8}
            spellCheck={false}
            aria-label="Description"
            placeholder={`${
              noProject
                ? "Ask anything, or describe what to try out or look into (markdown). Its agent works in its own folder, with no repository, and can use the board."
                : taskType === "scratch"
                  ? "Ask anything about the project, or describe what to look into or try out (markdown). Its agent works in its own folder, reads the repository and can use the board."
                  : docType === "plan"
                    ? "Describe what to plan. Its agent looks into it and writes an HTML plan that you iterate on together (markdown)."
                    : docType === "artifact"
                      ? "Describe the artifact: what it's for and what it should show or do (markdown). Its agent designs it as an HTML page, kept and shown in the task."
                      : docType === "diagram"
                        ? "Describe what to diagram: the flow, structure or sequence to show (markdown). Its agent draws it as a Mermaid diagram."
                        : asGroup
                          ? "Describe the work. Its agent plans it across the group's projects and creates their tasks (markdown)."
                          : asSubproject
                            ? "Describe the subproject. Its agent plans it as a series of small tasks, which merge into its branch (markdown)."
                            : "Describe the task. This becomes the agent's instructions (markdown), and a title is written from it."
            } ${tokenHint}`}
            value={description}
            onChange={(e) => {
              setHl(0);
              setDescription(e.target.value);
              setCaret(e.target.selectionStart);
              setClosedAt(null);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onScroll={(e) => {
              if (mirror.current) mirror.current.scrollTop = e.currentTarget.scrollTop;
              setScrolled(e.currentTarget.scrollTop);
            }}
            onKeyDown={(e) => {
              if (!listOpen || e.nativeEvent.isComposing) return;
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setHl((lit + (e.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
              } else if ((e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) || (e.key === "Tab" && !e.shiftKey)) {
                e.preventDefault();
                pick(matches[lit]);
              } else if (e.key === "Escape") {
                // Closes the list, not the dialog.
                e.preventDefault();
                e.stopPropagation();
                setClosedAt(completing!.start);
              }
            }}
            onPaste={attach.onPaste}
            className={clsx(EDITOR_TEXT, "relative block w-full resize-y bg-transparent text-transparent caret-fg outline-none selection:bg-accent/30 placeholder:text-faint")}
          />
          {listOpen && (
            <div
              ref={list}
              role="listbox"
              aria-label={TOKEN_HELP.find((h) => h.prefix === completing!.prefix)!.what}
              className="fixed z-10 w-72 overflow-y-auto rounded-lg border border-line-strong bg-panel-2 p-1 shadow-xl shadow-black/50"
              // Keeps the editor focused, so picking doesn't close the list first.
              onMouseDown={(e) => e.preventDefault()}
            >
              <div className="px-2 pt-1 pb-1 text-[10.5px] font-semibold tracking-wider text-faint uppercase">
                {{ "/": "Type or label", "@": "Where it goes", "!": "Model", "^": "Effort", "#": "Depends on" }[completing!.prefix]}
              </div>
              {matches.map((s, i) => (
                <button
                  key={s.value}
                  type="button"
                  role="option"
                  aria-selected={i === lit}
                  title={s.hint}
                  onMouseEnter={() => setHl(i)}
                  onClick={() => pick(s)}
                  className={clsx("flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px]", i === lit ? "bg-raised text-fg" : "text-muted")}
                >
                  <code className="shrink-0 font-mono text-[12px] text-accent">
                    {completing!.prefix}
                    {s.value}
                  </code>
                  <span className="truncate">{s.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-faint" aria-label="Reads as">
          <span className="mr-0.5">Reads as</span>
          {typeInfo && (
            <ReadsChip
              icon={asGroup && !docType ? <Folder size={12} /> : typeInfo.icon}
              label={asGroup && !docType ? "Group task" : typeInfo.label}
              title={typeInfo.hint}
              onRemove={typeSet ? removeKind("/") : undefined}
              removeTitle="Remove the type"
            />
          )}
          {labels.map((l) => (
            <ReadsChip
              key={l}
              icon={documentInfo(l).icon}
              label={labelling ? documentInfo(l).label : `${documentInfo(l).label} task`}
              title={documentInfo(l).hint}
              onRemove={() => untoken((t) => t.prefix === "/" && t.value === l)}
              removeTitle={labelling ? "Remove the label" : "Remove the type"}
            />
          ))}
          <ReadsChip
            icon={noProject ? <NotebookPen size={12} /> : asGroup ? <Folder size={12} /> : <FolderGit2 size={12} />}
            label={noProject ? `No project (${scratch!.name})` : asGroup ? group : subproject ? `${project!.key}-${subproject.number}` : project!.name}
            onRemove={setBy("@") ? removeKind("@") : undefined}
            removeTitle="Go back to where it started"
          />
          {named.length ? (
            // One for each task it makes, with the model it names.
            named.map((h) => (
              <ReadsChip
                key={`${h.config}/${h.model}`}
                icon={<Cpu size={12} />}
                label={runLabel(h)}
                onRemove={() => untoken((t) => t.prefix === "!" && sameHarness(harnessOf(t.value), h))}
                removeTitle={fanout ? "Don't make a task with this model" : "Remove the model"}
              />
            ))
          ) : model ? (
            <ReadsChip
              icon={<Cpu size={12} />}
              label={modelLabel(runs[0].model || model)}
              title={codex && !runs[0].model ? "A Claude model, which Codex doesn't run: it uses the default" : undefined}
              onRemove={() => setModel("")}
              removeTitle="Use the default model"
            />
          ) : (
            <ReadsChip dashed label={inherited ? `default model (${inherited})` : "default model"} />
          )}
          {efforts &&
            (pickedEffort ? (
              <ReadsChip
                icon={<Gauge size={12} />}
                label={`${pickedEffort} effort`}
                onRemove={setBy("^") ? removeKind("^") : () => setEffort("")}
                removeTitle={setBy("^") ? "Remove the effort" : "Use the default effort"}
              />
            ) : (
              <ReadsChip
                dashed
                label={hostSettings?.default_effort ? `default effort (${hostSettings.default_effort})` : "default effort"}
                onRemove={setBy("^") ? removeKind("^") : undefined}
              />
            ))}
          {dependsOn.map((id) => {
            const t = depTasks.find((x) => x.id === id)!;
            return (
              <ReadsChip
                key={id}
                icon={<Link2 size={12} />}
                label={`after ${depKey(t)}`}
                title={`Its agent starts once ${depKey(t)} (${t.title}) is merged`}
                onRemove={() => untoken((x) => x.prefix === "#" && x.value === depKey(t))}
              />
            );
          })}
        </div>
        <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-[11.5px] text-faint">
          {help.map((h) => (
            <button key={h.prefix} type="button" className="hover:text-muted" title={`Type ${h.prefix} for ${h.asks}`} onClick={() => typePrefix(h.prefix)}>
              <code className="font-mono text-muted">
                {h.prefix}
                {example[h.prefix]}
              </code>{" "}
              {h.what}
            </button>
          ))}
        </div>
        <DraftAttachments draft={attach} hostId={target.host_id} />
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3 pt-1">
          {!subproject && inProject && codeTask && !asSubproject && !fanout && <Toggle checked={worktree} onChange={setWorktree} label="Own git worktree" />}
          {agents && <Toggle checked={start} onChange={setStart} label="Start agent now" />}
          {pickConfig && <ConfigSelect className={pickerClass} configs={configs} value={config} onChange={setConfig} />}
          <ConfigUsageNote config={configObj} />
          <div className="-my-1 ml-auto flex items-center gap-1">
            {linking && (
              <button
                type="button"
                onClick={() => setPickingLink(true)}
                title="Link the Asana task this is for"
                className="flex h-7 items-center justify-center gap-1.5 rounded-md px-2 text-[12px] text-faint hover:bg-white/5 hover:text-fg"
              >
                <AsanaIcon size={13} /> Link Asana task
              </button>
            )}
            <AttachButton draft={attach} label="Attach files" />
          </div>
        </div>
        {linking && links.length > 0 && <LinkList chips links={links} onRemove={(l) => setLinks((ls) => ls.filter((x) => x !== l))} />}
        {asGroup && !docType && (
          <div className="text-[12px] text-muted">
            In no project: it shows on this group's board, and its agent breaks the work into tasks in{" "}
            {projects?.map((p) => p.name).join(", ")} and follows them. It doesn't change the repositories itself.
          </div>
        )}
        {noProject && (
          <div className="text-[12px] text-muted">
            In no project: it shows on the {scratch!.name} board{hostCount > 1 ? ` and runs on ${host?.name}` : ""}. Its agent works in the task's own folder, with
            no repository, and can look across the board and create and start tasks.
          </div>
        )}
        {taskType === "scratch" && inProject && (
          <div className="text-[12px] text-muted">
            Its agent works in the task's own folder and reads{" "}
            {subproject ? "the repository and the subproject's worktree without changing them" : "the repository without changing it"}, and can look across the
            board and create and start tasks{subproject ? " (in the subproject)" : ""}. There's no worktree, review or merge.
          </div>
        )}
        {labelling && labels.length > 0 && (
          <div className="text-[12px] text-muted">
            Besides its other work, its agent writes {labelList(labels)} in the task's own folder, each shown in a tab of the task.
            {labels.includes("plan") && " It writes the plan first, for you to agree on before it starts the work."}
          </div>
        )}
        {docType && (
          <div className="text-[12px] text-muted">
            {asGroup
              ? `In no project: it shows on this group's board, and its agent reads ${projects?.map((p) => p.name).join(", ")} as it writes the ${docType}.`
              : `Its agent reads the repository and writes the ${docType} in the task's own folder, without changing the code.`}{" "}
            The task shows it as it's written; reply in the task to iterate on it.
          </div>
        )}
        {(asSubproject || (subproject && taskType === null)) && (
          <div className="text-[12px] text-muted">
            {subproject
              ? `Branches from ${subproject.branch ?? "the subproject's branch"} and merges back into it.`
              : "It gets its own worktree and thread, and a board of tasks: each branches from the subproject's branch and merges back into it, and the subproject is merged as a whole through its own pull request."}
          </div>
        )}
        {labelBlock && <div className="text-[12px] text-amber-300">{labelBlock}</div>}
        {fanout && (
          <div className={clsx("text-[12px]", fanoutBlock ? "text-amber-300" : "text-muted")}>
            {fanoutBlock ??
              (many
                ? `Makes ${runs.length} ${noun}s from this prompt, one with each model${worktree ? ", each in its own worktree" : ""}${pending ? `, with ${pending.made.join(", ")}` : ", so you can compare what they do"}. Their cards say which is which.`
                : `Makes the ${noun} left from this prompt, with ${pending!.made.join(", ")}${worktree ? ", in its own worktree" : ""}. Their cards say which is which.`)}
          </div>
        )}
        {modelsBlock && (
          <div className={clsx("text-[12px]", modelsLoading ? "text-muted" : "text-amber-300")}>
            {modelsBlock}
            {whenLoaded && " It's created once they're in."}
          </div>
        )}
        <ModalFooter className="space-y-3">
          {err && <div className="text-xs text-red-400">{err}</div>}
          <div className="-mx-4 flex items-center justify-end gap-2 border-t border-line px-4 pt-4">
            <span className="mr-auto flex min-w-0 items-center gap-3">
              <Toggle checked={addAnother} onChange={changeAddAnother} label="Add another" />
              {created && (
                <span className="truncate text-xs text-muted" title={created.title}>
                  Created {created.key}
                </span>
              )}
            </span>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || attach.uploading || !hasContent || !!submitBlock}>
              {many
                ? start && deps && dependsOn.length
                  ? `Create & queue ${runs.length}`
                  : start
                    ? `Create & start ${runs.length}`
                    : `Create ${runs.length} ${noun}s`
                : start && deps && dependsOn.length
                  ? "Create & queue"
                  : start
                    ? "Create & start"
                    : `Create ${noun}`}
              <span className="translate-y-px text-[11px] font-normal text-white/60 touch:hidden">{SUBMIT_KEYS}</span>
            </Button>
          </div>
        </ModalFooter>
      </form>
      {pickingLink && (
        <AsanaPicker
          hostId={target.host_id}
          profileId={target.profile_id}
          linked={links}
          onClose={() => setPickingLink(false)}
          onPick={(t) => {
            setPickingLink(false);
            setLinks((ls) => [...ls, asanaLink(t)]);
            // Nothing written yet (tokens aside): the Asana task says what to do.
            const about = [t.name, t.notes.trim()].filter(Boolean).join("\n\n");
            const next = description.trim() ? `${description.trimEnd()}\n\n${about}` : about;
            if (!text.trim()) edit(next, next.length);
            else input.current?.focus();
          }}
        />
      )}
    </Modal>
  );
}
