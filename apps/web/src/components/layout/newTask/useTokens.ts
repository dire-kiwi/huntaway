import { useEffect, useState } from "react"
import { useShallow } from "../../boardHelpers"
import { agentOf, documentsOnly, isMerged, isScratch, LABELS, type HostTask as Task } from "@huntaway/client"
import { ProjectId, type DocumentLabel as DocumentType } from "@huntaway/contracts"
import { rpc } from "../../../state/rpc"
import { effortOptions, inheritedModel, isClaudeModel, modelOptions } from "../../../agents"
import { harnessesOf, harnessWords, type Harness, type HarnessConfig, type HarnessWord } from "../harnesses"
import { allValues, lastValue, removeTokens, stripTokens, type Token } from "../taskTokens"

import { asEffort, type Draft, type PendingFanout } from "./draft"
import type { AgentChoice } from "./useAgentChoice"
import type { EditorText } from "./useEditorText"
import type { Where } from "./useWhere"
import { DEFAULT_WORD, LABEL_WORDS, typeWord, type NewTaskType } from "./words"
import { useBoard } from "../../../state/board"

export type Tokens = ReturnType<typeof useTokens>

/**
 * What the description's tokens say: its type and labels, the tasks it waits for, what its worktree starts from, the
 * task it merges into, the harnesses it runs with (see useHarnesses) and its effort, and the text its agent is given without them.
 */
export function useTokens(where: Where, agent: AgentChoice, ed: EditorText, saved: Draft | null) {
  const { resolve, atVocab, offered, typeOf, inProject, asGroup } = where
  const { efforts, effort } = agent
  const { description, caret, edit, found } = ed
  // Tasks to merge before its agent starts (API 24), as `#` and their key.
  const preTokens = resolve({ "/": offered.map(typeWord) })
  const typeTab = typeOf(lastValue(preTokens, "/"))
  const taskType: NewTaskType = typeTab ? typeTab.id : (offered[0] ?? null)
  const deps = !!inProject && taskType !== "scratch"
  const depProject = deps ? inProject : undefined
  const depTasks = useBoard(
    useShallow((s) =>
      depProject
        ? Object.values(s.tasks)
            .filter((t) => t.kind === "task" && t.project_id === depProject.id && !isMerged(t))
            .toSorted((a, b) => b.number - a.number)
        : [],
    ),
  )
  const depKey = (t: Task) => `${depProject?.key}-${t.number}`
  // What its worktree starts from (API 96), as `from:` and another task's key (to land after that task, from its branch), a
  // branch, a pull request (`#12` or its URL) or a commit, which the host makes out. A key of the project's that isn't one
  // of its tasks to start from isn't known.
  const fromOk = deps
  const fromTasks = fromOk ? depTasks.filter((t) => (t.use_worktree || !!t.branch) && !isScratch(t) && !documentsOnly(t)) : []
  const fromKeys = fromTasks.map(depKey)
  const keyLike = (w: string) => new RegExp(`^${inProject?.key}-\\d+$`, "i").test(w)
  const fromWords = fromOk ? [...fromKeys, ...found.filter((t) => t.prefix === "from:" && !keyLike(t.word)).map((t) => t.word)] : []
  // The project's branches, for the list, once a `from:` is typed (`projects.branches`).
  const [branches, setBranches] = useState<{ project: string; list: ReadonlyArray<{ name: string; remote: boolean }> } | null>(null)
  const fromTyped = fromOk && (found.some((t) => t.prefix === "from:") || ed.completing?.prefix === "from:")
  const branchHost = fromTyped ? inProject?.host_id : undefined
  const branchProject = fromTyped ? inProject?.id : undefined
  useEffect(() => {
    if (branchHost === undefined || branchProject === undefined) return undefined
    let live = true
    rpc(branchHost, "projects.branches", { id: ProjectId.make(branchProject) })
      .then((list) => {
        if (live) setBranches({ project: branchProject, list })
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [branchHost, branchProject])
  const projectBranches = fromOk && branches && branches.project === inProject?.id ? branches.list : []
  // The task whose branch its work merges into (API 128), as `into:` and its key: an open code task in the project with
  // a branch of its own (or a worktree to make one).
  const intoOk = deps
  const intoTasks = intoOk ? depTasks.filter((t) => t.status !== "done" && (t.use_worktree || !!t.branch) && !isScratch(t) && !documentsOnly(t)) : []
  const intoKeys = intoTasks.map(depKey)

  const harnesses = useHarnesses(where, agent, ed, saved)
  const { modelVocab, effortList } = harnesses
  // Labels, each a document its agent writes besides its other work, shown in a tab of the task.
  const labelling = true
  const labelWords = LABEL_WORDS
  const tokens = resolve({
    "in:": atVocab,
    "/": [...offered.map(typeWord), ...labelWords],
    "!": modelVocab,
    ...(efforts ? { "^": [DEFAULT_WORD, ...effortList] } : {}),
    ...(deps ? { "#": depTasks.map(depKey) } : {}),
    ...(fromOk ? { "from:": fromWords } : {}),
    ...(intoOk ? { "into:": intoKeys } : {}),
  })
  const effortAsked = lastValue(tokens, "^")
  const pickedEffort = effortAsked === undefined ? effort : asEffort(effortAsked)
  const dependsOn = allValues(tokens, "#").flatMap((k) => depTasks.filter((t) => depKey(t) === k).map((t) => t.id))
  const startFrom = lastValue(tokens, "from:")
  const fromTask = startFrom === undefined ? undefined : fromTasks.find((t) => depKey(t) === startFrom)
  const intoKey = lastValue(tokens, "into:")
  const intoTask = intoKey === undefined ? undefined : intoTasks.find((t) => depKey(t) === intoKey)
  // What its agent is given: the description without its tokens.
  const text = stripTokens(description, tokens)

  const labels = LABELS.filter((l) => allValues(tokens, "/").includes(l))
  // What a host before labels made a label as (one at most): none now.
  const docType: DocumentType | null = null
  const codeTask = taskType === null && !docType
  // What it merges into, for a code task (which then gets a worktree).
  const mergesInto = codeTask ? intoTask : undefined
  const noun = taskType === "scratch" ? "scratch task" : asGroup && !docType ? "group task" : (docType ?? taskType ?? "task")
  // What starting from it means, under the editor.
  const pr = startFrom?.match(/^#(\d+)$|\/pull\/(\d+)/)
  const fromNote =
    startFrom === undefined || !codeTask
      ? null
      : fromTask
        ? `Lands after ${startFrom}: its worktree starts from ${startFrom}'s branch${fromTask.branch ? ` ${fromTask.branch}` : " (set up first if it has none yet)"}, which its pull request targets and its changes are compared with. Once ${startFrom} is merged, it merges where that went. Once both have pull requests on GitHub, the board stacks this one on ${startFrom}'s there (GitHub's stacked pull requests) if it can.`
        : pr
          ? `Its worktree starts from pull request #${pr[1] ?? pr[2]}'s branch, which its pull request targets and its changes are compared with.`
          : /^(commit:)?[0-9a-f]{7,40}$/i.test(startFrom)
            ? `Its worktree starts from commit ${startFrom.replace(/^commit:/, "")}, and it merges into the base branch.`
            : `Its worktree starts from ${startFrom.replace(/^branch:/, "")}, which its pull request targets and its changes are compared with.`
  const intoNote = mergesInto
    ? `Merges into ${intoKey}: its worktree starts from ${intoKey}'s branch unless from: says otherwise, its pull request targets it, and Ready for merge merges it there.`
    : null

  // Takes tokens out of the text (the "Reads as" row's ×).
  const untoken = (which: (t: Token) => boolean) => {
    const gone = tokens.filter((t) => t.value !== undefined && which(t))
    const next = removeTokens(description, gone)
    edit(next, Math.min(next.length, Math.max(0, caret - gone.filter((t) => t.end <= caret).reduce((n, t) => n + t.end - t.start, 0))))
  }

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
    intoOk,
    intoTasks,
    intoKeys,
    intoKey,
    mergesInto,
    intoNote,
    labelling,
    labelWords,
    tokens,
    pickedEffort,
    dependsOn,
    text,
    labels,
    docType,
    codeTask,
    noun,
    untoken,
  }
}

/** What `!` names, and the harnesses (config and model) it makes a task with each of, or that's left of them (IA-227). */
function useHarnesses({ resolve, inProject }: Where, agent: AgentChoice, { description, found }: EditorText, saved: Draft | null) {
  const { configs, configModels, modelList, config, codex, model, profile, hostSettings, efforts, pickConfig } = agent
  // What `!` names: a model of any of the configs, or one's default model (see harnesses.ts). With no configs to pick
  // from, Claude's own config.
  const harnessConfigs: HarnessConfig[] = configs.length
    ? configs.map((c) => ({ id: c.id, name: c.name, agent: agentOf(c), models: modelOptions(c, configModels[c.id] ?? null) }))
    : [{ id: "", name: "", agent: "claude", models: modelList }]
  // Claude takes a full model id too (what "Specific model…" was for), in the picked config or the first Claude one.
  const claudeConfig = harnessConfigs.find((c) => c.id === config && c.agent === "claude") ?? harnessConfigs.find((c) => c.agent === "claude")
  const specific: HarnessWord[] = claudeConfig
    ? found
        .filter((t) => t.prefix === "!" && /^claude-[\w.-]+$/i.test(t.word))
        .map((t) => ({ word: t.word.toLowerCase(), harness: { config: claudeConfig.id, model: t.word.toLowerCase() }, label: t.word.toLowerCase() }))
    : []
  const harnessVocab = [...harnessWords(harnessConfigs, config, DEFAULT_WORD), ...specific]
  const modelVocab = harnessVocab.map((w) => w.word)
  // A task for each harness named (`!opus !gpt-5.5` makes two from one prompt); with none, one in the picked config
  // with the model last picked there.
  const named = harnessesOf(harnessVocab, allValues(resolve({ "!": modelVocab }), "!"))
  const runs: Harness[] = named.length ? named : [{ config, model: codex && isClaudeModel(model) ? "" : model }]
  // Several harnesses make a task each. After only some of them could be made, those left (even one) are made as part
  // of the same set when it's tried again: linked to the others by its id (null on hosts before API 61), in a worktree.
  // Kept with the draft, so closing the dialog (or reloading) before trying again doesn't lose it.
  const [pending, setPending] = useState<PendingFanout | null>(() => saved?.fanout ?? null)
  // Taking all the text out starts over.
  if (!description.trim() && pending !== null) setPending(null)
  const many = runs.length > 1
  const fanout = many || pending !== null
  const runConfig = (h: Harness) => configs.find((c) => c.id === h.config)
  // The efforts any of them takes; one that doesn't take the effort picked gets its default.
  // The model one on its default model runs with: the project's, profile's or host's (as runner::launch picks it), else its agent's.
  const runInherits = (h: Harness) =>
    inheritedModel(runConfig(h), configModels[h.config] ?? null, inProject?.model, profile?.default_model, hostSettings?.default_model)
  const runEfforts = (h: Harness) => effortOptions(runConfig(h), configModels[h.config] ?? null, h.model || runInherits(h) || "")
  // Those of the tasks already made too, so a `^` that only they take is still read as one when the rest are made.
  const effortList = efforts ? [...new Set([...runs.flatMap(runEfforts), ...(pending?.efforts ?? [])])] : []
  const harnessOf = (word: string | undefined) => harnessVocab.find((w) => w.word === word)?.harness
  // A harness as the "Reads as" row has it: its model (or the one it inherits), and its config where there are several.
  const runLabel = (h: Harness) => {
    const c = harnessConfigs.find((x) => x.id === h.config)
    const inherits = h.model ? undefined : runInherits(h)
    const m = h.model ? (c?.models.find((x) => x.id === h.model)?.label ?? h.model) : inherits ? `default model (${inherits})` : "default model"
    return pickConfig && c ? `${m} · ${c.name}` : m
  }
  return { harnessConfigs, specific, harnessVocab, modelVocab, named, runs, pending, setPending, many, fanout, runEfforts, effortList, harnessOf, runLabel }
}
