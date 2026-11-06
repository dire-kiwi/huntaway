import { useEffect, useRef, useState } from "react";
import { api, hostSupports, type Effort, type Status, type Task } from "../../../api";
import { newFanoutId, sameHarness } from "../harnesses";
import { keyPrefix } from "../../../store";
import { withAttachments } from "../../../attachments";
import { configKey, draftKey, effortKey, loadDraft, modelKey, PROJECT_KEY, startKey, type Draft } from "./draft";
import type { Blocks } from "./blocks";
import type { AgentChoice } from "./useAgentChoice";
import type { DraftExtras } from "./useDraft";
import type { EditorText } from "./useEditorText";
import type { Options } from "./useOptions";
import type { Tokens } from "./useTokens";
import type { Opened, Origin, Where } from "./useWhere";

export type Submit = ReturnType<typeof useSubmit>;

/**
 * Creating the task (or a task for each harness), and what follows: with "Add another", the next one's draft where
 * it went. Moving somewhere else (by an `@`, or a type that goes elsewhere) brings that place's remembered options.
 */
export function useSubmit(p: {
  opened: Opened;
  status: Status;
  onClose: () => void;
  origin: Origin;
  ed: EditorText;
  where: Where;
  agent: AgentChoice;
  tok: Tokens;
  kept: DraftExtras;
  options: Options;
  blocks: Blocks;
}) {
  const { status, onClose } = p;
  const { projects, subproject } = p.opened;
  const { group, setBase, draft } = p.origin;
  const { setClosedAt, edit, description } = p.ed;
  const { heldBack, prefId, target, noProject, asGroup, project, inProject, host } = p.where;
  const { setModel, setEffort, setConfigPref, model, config, pickConfig, efforts } = p.agent;
  const { pending, setPending, runs, fanout, labelling, labels, text, docType, taskType, deps, dependsOn } = p.tok;
  const { runEfforts, pickedEffort, untoken, harnessOf, effortList, runLabel, named, tokens, startFrom, fromTask, codeTask } = p.tok;
  // As useTokens has it, here so that it narrows taskType below.
  const asSubproject = taskType === "subproject";
  const { attach, links, setLinks, hasContent, linking } = p.kept;
  const { start, worktree, addAnother, setStartPref, setWorktree } = p.options;
  const { submitBlock, modelsLoading } = p.blocks;
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
                    ...(startFrom !== undefined && codeTask ? { start_from: fromTask ? `task:${fromTask.id}` : startFrom } : {}),
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

  useEffect(() => {
    const justSwitched = switched.current;
    switched.current = false;
    if (!settling) return;
    // Somewhere else's remembered options are only in place after another render.
    if (justSwitched) return setSettling((n) => n + 1);
    setSettling(0);
    submit();
  });

  return { busy, err, created, submit, whenLoaded };
}
