import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { keyPrefix, withAttachments, type HostTask as Task } from "@huntaway/client"
import { AgentConfigId, HostId, ProfileId, type Status } from "@huntaway/contracts"
import { newFanoutId, sameHarness, type Harness } from "../harnesses"

import { asEffort, configKey, draftKey, effortKey, loadDraft, modelKey, PROJECT_KEY, startKey, type Draft } from "./draft"
import type { Blocks } from "./blocks"
import type { AgentChoice } from "./useAgentChoice"
import type { DraftExtras } from "./useDraft"
import type { EditorText } from "./useEditorText"
import type { Options } from "./useOptions"
import type { Tokens } from "./useTokens"
import type { Opened, Origin, Where } from "./useWhere"
import { rpc } from "../../../state/rpc"
import { errorText } from "../../ui"

export type Submit = ReturnType<typeof useSubmit>

/**
 * Creating the task (or a task for each harness), and what follows: with "Add another", the next one's draft where
 * it went. Moving somewhere else (by an `in:`, or a type that goes elsewhere) brings that place's remembered options.
 */
export function useSubmit(p: {
  opened: Opened
  status: Status
  onClose: () => void
  onCreated?: ((tasks: Task[]) => void) | undefined
  origin: Origin
  ed: EditorText
  where: Where
  agent: AgentChoice
  tok: Tokens
  kept: DraftExtras
  options: Options
  blocks: Blocks
}) {
  const { status, onClose, onCreated } = p
  const { projects } = p.opened
  const { group, setBase, draft } = p.origin
  const { setClosedAt, edit, description } = p.ed
  const { heldBack, prefId, target, noProject, asGroup, project, inProject } = p.where
  const { setModel, setEffort, setConfigPref, model, config, pickConfig, efforts } = p.agent
  const { pending, setPending, runs, fanout, labelling, labels, text, taskType, deps, dependsOn } = p.tok
  const { runEfforts, pickedEffort, untoken, harnessOf, effortList, runLabel, named, tokens, startFrom, fromTask, codeTask, mergesInto } = p.tok
  const { attach, links, setLinks, hasContent, linking } = p.kept
  const { start, worktree, addAnother, setStartPref, setWorktree } = p.options
  const { submitBlock, modelsLoading } = p.blocks
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // The last task created while "Add another" is on, so there's feedback that it went through (its key as it was made,
  // as the dialog may have moved since).
  const [created, setCreated] = useState<{ key: string; title: string } | null>(null)

  // Somewhere else (by an `in:`, or a type that goes elsewhere) brings its own remembered options. Asana tasks go along
  // within the profile, which is where they were found, and files uploaded to another host would be lost.
  const was = useRef({ prefId, ...target })
  const switched = useRef(false)
  // What a move somewhere else does, as of this render: the effect below runs it only when where it goes changes.
  const onMove = useRef((_to: { prefId: string; host_id: string; profile_id: string }) => {})
  useLayoutEffect(() => {
    onMove.current = (to) => {
      const from = was.current
      if (from.prefId === to.prefId) return
      was.current = to
      setModel(localStorage.getItem(modelKey(prefId)) ?? "")
      setEffort(asEffort(localStorage.getItem(effortKey(prefId))))
      setConfigPref(localStorage.getItem(configKey(prefId)) ?? "")
      setStartPref(localStorage.getItem(startKey(prefId)) === "1")
      setWorktree(null)
      setCreated(null)
      setPending(null)
      switched.current = true
      if (from.host_id !== to.host_id || from.profile_id !== to.profile_id) setLinks([])
      if (from.host_id !== to.host_id) attach.clear()
    }
  })
  const { host_id: hostId, profile_id: profileId } = target
  useEffect(() => onMove.current({ prefId, host_id: hostId, profile_id: profileId }), [prefId, hostId, profileId])
  // A draft brought back (by Add another) has its files and Asana tasks where its own tokens send it, so they're put
  // back after the move there above has dropped those of where the dialog was.
  // So is the note of the task just created, which the move drops.
  const [restoring, setRestoring] = useState<{ draft: Draft; made: { key: string; title: string } } | null>(null)
  const onRestore = useRef((_back: { draft: Draft; made: { key: string; title: string } }) => {})
  useLayoutEffect(() => {
    onRestore.current = ({ draft: theirs, made }) => {
      setRestoring(null)
      attach.clear()
      setLinks(theirs.links ?? [])
      setPending(theirs.fanout ?? null)
      if (attach.enabled) attach.restore(theirs.files)
      setCreated(made)
    }
  })
  useEffect(() => {
    if (restoring) onRestore.current(restoring)
  }, [restoring])

  // Ctrl+Enter in an `in:` being typed takes it as it is first (and what it brings, from the next render on), so what's
  // created is what the text says.
  const [settling, setSettling] = useState(0)
  const submit = async () => {
    if (heldBack) {
      setClosedAt(heldBack.start)
      setSettling(1)
      return
    }
    if (!hasContent || busy || attach.uploading || submitBlock) return
    if (modelsLoading) return setWhenLoaded(true)
    setBusy(true)
    setErr(null)
    // A task for each harness, one after another, so a failure leaves the rest to try again.
    const tasks: Task[] = []
    const fanoutId = pending ? pending.id : fanout ? newFanoutId() : null
    const shared = fanoutId ? { fanout_id: fanoutId } : {}
    try {
      // One after another (each waits for the one before), so a failure leaves the rest to try again.
      const makeFrom = async (i: number): Promise<{ run: Harness; error: unknown } | null> => {
        const run = runs[i]
        if (!run) return null
        // The server titles it from the description.
        const runEffort = efforts && pickedEffort && runEfforts(run).includes(pickedEffort) ? pickedEffort : undefined
        const common = {
          ...(labelling && labels.length ? { labels } : {}),
          description: withAttachments(text, attach.files),
          start,
          status,
          ...(run.model ? { model: run.model } : {}),
          ...(runEffort ? { effort: runEffort } : {}),
          ...(pickConfig ? { claude_config_id: AgentConfigId.make(run.config) } : {}),
          ...(linking && links.length ? { external_links: links } : {}),
          ...shared,
        }
        try {
          const made = noProject
            ? await rpc(target.host_id, "tasks.create", { task: { ...common, profile_id: ProfileId.make(target.profile_id) } })
            : asGroup && group
              ? await rpc(target.host_id, "tasks.create", { task: { ...common, profile_id: ProfileId.make(target.profile_id), group } })
              : project
                ? await rpc(project.host_id, "tasks.create", {
                    task: {
                      ...common,
                      project_id: project.id,
                      use_worktree: worktree,
                      ...(taskType ? { task_type: taskType } : {}),
                      ...(deps && dependsOn.length ? { depends_on: dependsOn } : {}),
                      ...(startFrom !== undefined && codeTask ? { start_from: fromTask ? `task:${fromTask.id}` : startFrom } : {}),
                      ...(mergesInto ? { merges_into: mergesInto.id } : {}),
                    },
                  })
                : null
          if (!made) throw new Error("Pick a project for it")
          tasks.push({ ...made, host_id: HostId.make(noProject || (asGroup && group) ? target.host_id : (project?.host_id ?? target.host_id)) })
        } catch (error) {
          return { run, error }
        }
        return makeFrom(i + 1)
      }
      const failed = await makeFrom(0)
      if (failed) {
        if (!tasks.length) throw failed.error
        // Those made are taken out of the text, so trying again makes the others.
        const done = runs.slice(0, tasks.length)
        untoken((t) => t.prefix === "!" && done.some((h) => sameHarness(harnessOf(t.value), h)))
        const keys = tasks.map((t) => `${keyPrefix(t, inProject)}-${t.number}`)
        setPending({ id: fanoutId, made: [...(pending?.made ?? []), ...keys], efforts: effortList })
        setErr(`Made ${keys.join(", ")}, but not the one with ${runLabel(failed.run)}: ${errorText(failed.error)}`)
        setBusy(false)
        return
      }
      setPending(null)
      // With the host they were made on, as the board has them.
      onCreated?.(tasks)
      // One harness is what's picked from then on; several (or what's left of them) leave what was picked as it was.
      const only = fanout ? null : runs[0]
      if (only) {
        const m = named.length ? only.model : model
        setModel(m)
        localStorage.setItem(modelKey(prefId), m)
        if (only.config !== config) setConfigPref(only.config)
        if (pickConfig) localStorage.setItem(configKey(prefId), only.config)
      }
      setEffort(pickedEffort)
      if (efforts) localStorage.setItem(effortKey(prefId), pickedEffort)
      // Where it went is where the next one starts, where there's a choice.
      if (projects?.length) localStorage.setItem(PROJECT_KEY, prefId)
      localStorage.removeItem(draft)
      if (!addAnother) return onClose()
      const made = { key: tasks.map((t) => `${keyPrefix(t, inProject)}-${t.number}`).join(", "), title: tasks[0]?.title ?? "" }
      setCreated(made)
      // The dialog starts there now too, as it would opened again, so the next one's draft is kept there. A draft
      // already there comes back, rather than being written over.
      const there = projects?.length ? draftKey(prefId) : draft
      const theirs = there !== draft ? loadDraft(there) : null
      if (projects?.length) setBase({ projectId: project?.id, noProject, asGroup })
      attach.clear()
      if (theirs) {
        edit(theirs.description, theirs.description.length)
        setRestoring({ draft: theirs, made })
      } else {
        // Or it keeps the same options (its tokens) for the next one.
        const kept = tokens.flatMap((t) => (t.value !== undefined ? [description.slice(t.start, t.end)] : [])).join(" ")
        edit(kept && `${kept} `, kept ? kept.length + 1 : 0)
        setLinks([])
      }
      setBusy(false)
    } catch (e) {
      setErr(errorText(e))
      setBusy(false)
    }
  }

  // Created once the models it waits for are in, if it was asked for meanwhile (and the text hasn't changed since).
  const [whenLoaded, setWhenLoaded] = useState(false)
  const [describing, setDescribing] = useState(description)
  if (describing !== description) {
    setDescribing(description)
    setWhenLoaded(false)
  }
  const submitNow = useRef(submit)
  useLayoutEffect(() => {
    submitNow.current = submit
  })
  const loadedNow = whenLoaded && !modelsLoading
  useEffect(() => {
    if (!loadedNow) return
    setWhenLoaded(false)
    void submitNow.current()
  }, [loadedNow, setWhenLoaded])

  // Each render while it settles: once where the text sends it has brought its options (a move takes one more
  // render), it's created.
  useEffect(() => {
    const justSwitched = switched.current
    switched.current = false
    if (!settling) return
    // Somewhere else's remembered options are only in place after another render.
    if (justSwitched) {
      setSettling((n) => n + 1)
      return
    }
    setSettling(0)
    void submitNow.current()
  }, [settling])

  return { busy, err, created, submit, whenLoaded }
}
