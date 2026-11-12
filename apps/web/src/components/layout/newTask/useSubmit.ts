import { Cause, Effect, Exit, Schema } from "effect"
import { type AtomRegistry } from "effect/reactivity"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { type CallError, keyPrefix, mutate, withAttachments, type HostTask as Task } from "@huntaway/client"
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
import { errorText, exitError, useAction } from "../../../state/mutation"

export type Submit = ReturnType<typeof useSubmit>

/** A task as made on `host`, with the host, as the board has it. */
const on =
  (host: string) =>
  <T extends object>(made: T) => ({ ...made, host_id: HostId.make(host) })

/** Where the dialog would put it isn't a project, a group or a profile's scratch tasks. */
class NoProject extends Schema.TaggedError<NoProject, { readonly brand: unique symbol }>()("NoProject", { message: Schema.String }) {}

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
  const [{ busy }, run] = useAction()
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
  const submit = () => {
    if (heldBack) {
      setClosedAt(heldBack.start)
      setSettling(1)
      return
    }
    if (!hasContent || busy || attach.uploading || submitBlock) return
    if (modelsLoading) return setWhenLoaded(true)
    setErr(null)
    const fanoutId = pending ? pending.id : fanout ? newFanoutId() : null
    const shared = fanoutId ? { fanout_id: fanoutId } : {}
    /** Makes the task for harness `h`, with the host it was made on, as the board has it. */
    const make = (h: Harness): Effect.Effect<Task, CallError<"tasks.create"> | NoProject, AtomRegistry.AtomRegistry> => {
      // The server titles it from the description.
      const runEffort = efforts && pickedEffort && runEfforts(h).includes(pickedEffort) ? pickedEffort : undefined
      const common = {
        ...(labelling && labels.length ? { labels } : {}),
        description: withAttachments(text, attach.files),
        start,
        status,
        ...(h.model ? { model: h.model } : {}),
        ...(runEffort ? { effort: runEffort } : {}),
        ...(pickConfig ? { claude_config_id: AgentConfigId.make(h.config) } : {}),
        ...(linking && links.length ? { external_links: links } : {}),
        ...shared,
      }
      if (noProject)
        return mutate("tasks.create", target.host_id, { task: { ...common, profile_id: ProfileId.make(target.profile_id) } }).pipe(
          Effect.map(on(target.host_id)),
        )
      if (asGroup && group)
        return mutate("tasks.create", target.host_id, { task: { ...common, profile_id: ProfileId.make(target.profile_id), group } }).pipe(
          Effect.map(on(target.host_id)),
        )
      if (!project) return Effect.fail(new NoProject({ message: "Pick a project for it" }))
      return mutate("tasks.create", project.host_id, {
        task: {
          ...common,
          project_id: project.id,
          use_worktree: worktree,
          ...(taskType ? { task_type: taskType } : {}),
          ...(deps && dependsOn.length ? { depends_on: dependsOn } : {}),
          ...(startFrom !== undefined && codeTask ? { start_from: fromTask ? `task:${fromTask.id}` : startFrom } : {}),
          ...(mergesInto ? { merges_into: mergesInto.id } : {}),
        },
      }).pipe(Effect.map(on(project.host_id)))
    }
    /** What follows once they're made, or some of them: `failed` is the first that wasn't, which the rest wait behind. */
    const done = (tasks: Task[], failed: { run: Harness; error: unknown } | null) => {
      if (failed) {
        if (!tasks.length) {
          setErr(errorText(failed.error))
          return
        }
        // Those made are taken out of the text, so trying again makes the others.
        const made = runs.slice(0, tasks.length)
        untoken((t) => t.prefix === "!" && made.some((h) => sameHarness(harnessOf(t.value), h)))
        const keys = tasks.map((t) => `${keyPrefix(t, inProject)}-${t.number}`)
        setPending({ id: fanoutId, made: [...(pending?.made ?? []), ...keys], efforts: effortList })
        setErr(`Made ${keys.join(", ")}, but not the one with ${runLabel(failed.run)}: ${errorText(failed.error)}`)
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
      if (!addAnother) {
        onClose()
        return
      }
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
    }
    // A task for each harness, one after another (each waits for the one before), so a failure leaves the rest to try
    // again.
    void run(
      Effect.gen(function* () {
        const tasks: Task[] = []
        for (const h of runs) {
          const made = yield* Effect.exit(make(h))
          if (Exit.isFailure(made)) {
            done(tasks, { run: h, error: Cause.squash(made.cause) })
            return
          }
          tasks.push(made.value)
        }
        done(tasks, null)
      }),
    ).then((exit) => {
      const failed = exitError(exit)
      if (failed !== null) setErr(failed)
    })
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
    submitNow.current()
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
    submitNow.current()
  }, [settling])

  return { busy, err, created, submit, whenLoaded }
}
