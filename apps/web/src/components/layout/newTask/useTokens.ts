import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { agentOf, api, documentsOnly, hostSupports, isMerged, isScratch, LABELS, LABELS_API, START_FROM_API, type Effort, type Task } from "../../../api";
import { effortOptions, inheritedModel, isClaudeModel, modelOptions } from "../../../agents";
import { harnessesOf, harnessWords, type Harness, type HarnessConfig, type HarnessWord } from "../harnesses";
import { allValues, lastValue, removeTokens, stripTokens, type Token } from "../taskTokens";
import { useStore } from "../../../store";
import type { Draft, PendingFanout } from "./draft";
import type { AgentChoice } from "./useAgentChoice";
import type { EditorText } from "./useEditorText";
import type { Where } from "./useWhere";
import { DEFAULT_WORD, LABEL_WORDS, typeWord, type NewTaskType } from "./words";

export type Tokens = ReturnType<typeof useTokens>;

/**
 * What the description's tokens say: its type and labels, the tasks it waits for, what its worktree starts from, the
 * harnesses it runs with (see useHarnesses) and its effort, and the text its agent is given without them. `subproject`
 * is the one it's added to, if any.
 */
export function useTokens(where: Where, agent: AgentChoice, ed: EditorText, saved: Draft | null, subproject: Task | undefined) {
  const { resolve, atVocab, offered, typeOf, host, inProject, noProject, asGroup } = where;
  const { efforts, effort } = agent;
  const { description, caret, edit, found, completing } = ed;
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
  // What its worktree starts from (API 96), as `from:` and another task's key (to stack it on that task's branch), a
  // branch, a pull request (`#12` or its URL) or a commit, which the host makes out. Not a subproject's task, which
  // starts from the subproject's branch. A key of the project's that isn't one of its tasks to stack on isn't known.
  const fromOk = deps && hostSupports(host, START_FROM_API) && !subproject;
  const fromTasks = fromOk ? depTasks.filter((t) => (t.use_worktree || !!t.branch) && !isScratch(t) && !documentsOnly(t)) : [];
  const fromKeys = fromTasks.map(depKey);
  const keyLike = (w: string) => new RegExp(`^${inProject?.key}-\\d+$`, "i").test(w);
  const fromWords = fromOk ? [...fromKeys, ...found.filter((t) => t.prefix === "from:" && !keyLike(t.word)).map((t) => t.word)] : [];
  // The project's branches, for the list, once a `from:` is typed.
  const [branches, setBranches] = useState<{ project: string; list: { name: string; remote: boolean }[] } | null>(null);
  const fromTyped = fromOk && (found.some((t) => t.prefix === "from:") || completing?.prefix === "from:");
  useEffect(() => {
    if (!fromTyped || !inProject || branches?.project === inProject.id) return;
    const id = inProject.id;
    setBranches({ project: id, list: [] });
    api
      .projectBranches(inProject.host_id, id)
      .then((r) => setBranches((b) => (b?.project === id ? { project: id, list: r.branches } : b)))
      .catch(() => {});
  }, [fromTyped, inProject?.host_id, inProject?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const projectBranches = fromOk && branches && branches.project === inProject?.id ? branches.list : [];

  const harnesses = useHarnesses(where, agent, ed, saved);
  const { modelVocab, effortList } = harnesses;
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
    ...(fromOk ? { "from:": fromWords } : {}),
  });
  const effortAsked = lastValue(tokens, "^");
  const pickedEffort = (effortAsked === undefined ? effort : effortAsked === DEFAULT_WORD ? "" : effortAsked) as Effort | "";
  const dependsOn = allValues(tokens, "#").flatMap((k) => depTasks.filter((t) => depKey(t) === k).map((t) => t.id));
  const startFrom = lastValue(tokens, "from:");
  const fromTask = startFrom === undefined ? undefined : fromTasks.find((t) => depKey(t) === startFrom);
  // What its agent is given: the description without its tokens.
  const text = stripTokens(description, tokens);

  const labels = LABELS.filter((l) => allValues(tokens, "/").includes(l));
  // On a host before API 71, the label it's made as (one at most).
  const docType = labelTypes ? (labels[0] ?? null) : null;
  // A subproject's branch is what its tasks branch from, so it and they get worktrees.
  const asSubproject = taskType === "subproject";
  const codeTask = (taskType === null && !docType) || asSubproject;
  const noun = taskType === "scratch" ? "scratch task" : asGroup && !docType ? "group task" : (docType ?? taskType ?? "task");
  // What starting from it means, under the editor.
  const pr = startFrom?.match(/^#(\d+)$|\/pull\/(\d+)/);
  const fromNote =
    startFrom === undefined || !codeTask
      ? null
      : fromTask
        ? `Stacked on ${startFrom}: its worktree starts from ${startFrom}'s branch${fromTask.branch ? ` ${fromTask.branch}` : " (set up first if it has none yet)"}, which its pull request targets and its changes are compared with. Once ${startFrom} is merged, it merges where that went.`
        : pr
          ? `Its worktree starts from pull request #${pr[1] ?? pr[2]}'s branch, which its pull request targets and its changes are compared with.`
          : /^(commit:)?[0-9a-f]{7,40}$/i.test(startFrom)
            ? `Its worktree starts from commit ${startFrom.replace(/^commit:/, "")}, and it merges into the base branch.`
            : `Its worktree starts from ${startFrom.replace(/^branch:/, "")}, which its pull request targets and its changes are compared with.`;

  // Takes tokens out of the text (the "Reads as" row's ×).
  const untoken = (which: (t: Token) => boolean) => {
    const gone = tokens.filter((t) => t.value !== undefined && which(t));
    const next = removeTokens(description, gone);
    edit(next, Math.min(next.length, Math.max(0, caret - gone.filter((t) => t.end <= caret).reduce((n, t) => n + t.end - t.start, 0))));
  };

  return {
    ...harnesses,
    taskType,
    deps,
    depProject,
    depTasks,
    depKey,
    fromOk,
    fromTasks,
    fromKeys,
    projectBranches,
    startFrom,
    fromTask,
    fromNote,
    labelling,
    labelTypes,
    labelWords,
    tokens,
    pickedEffort,
    dependsOn,
    text,
    labels,
    docType,
    asSubproject,
    codeTask,
    noun,
    untoken,
  };
}

/** What `!` names, and the harnesses (config and model) it makes a task with each of, or that's left of them (IA-227). */
function useHarnesses({ resolve, inProject }: Where, agent: AgentChoice, { description, found }: EditorText, saved: Draft | null) {
  const { configs, configModels, modelList, config, codex, model, profile, hostSettings, efforts, pickConfig } = agent;
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
  return { harnessConfigs, specific, harnessVocab, modelVocab, named, runs, pending, setPending, many, fanout, runEfforts, effortList, harnessOf, runLabel };
}
