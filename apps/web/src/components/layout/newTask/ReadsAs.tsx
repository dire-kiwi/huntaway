import { clsx } from "clsx"
import { Cpu, Folder, FolderGit2, Gauge, GitBranch, GitMerge, Link2, NotebookPen, X } from "lucide-react"
import type { ReactNode } from "react"
import { sameHarness } from "../harnesses"
import type { TokenPrefix } from "../taskTokens"
import { documentInfo } from "../../task/documentInfo"
import type { AgentChoice } from "./useAgentChoice"
import type { Tokens } from "./useTokens"
import type { Opened, Origin, Where } from "./useWhere"
import { isLabelWord } from "./words"

/** A value in the "Reads as" row: one a token set has an × that takes the token out; a dashed one is the default. */
function ReadsChip({
  icon,
  label,
  title,
  onRemove,
  removeTitle = "Remove",
  dashed,
}: {
  icon?: ReactNode | undefined
  label: ReactNode
  title?: string | undefined
  onRemove?: (() => void) | undefined
  removeTitle?: string | undefined
  dashed?: boolean | undefined
}) {
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
        <button
          type="button"
          className="-mr-0.5 shrink-0 rounded p-0.5 text-faint hover:bg-white/5 hover:text-fg"
          title={removeTitle}
          aria-label={removeTitle}
          onClick={onRemove}
        >
          <X size={11} />
        </button>
      )}
    </span>
  )
}

/** The "Reads as" row: what the tokens (or the options last picked) make of the task, each a chip. */
export function ReadsAs({ opened, origin, where, agent, tok }: { opened: Opened; origin: Origin; where: Where; agent: AgentChoice; tok: Tokens }) {
  const { scratch } = opened
  const { group } = origin
  const { typeTabs, noProject, asGroup, project } = where
  const { model, setModel, codex, inherited, efforts, setEffort, hostSettings, modelList } = agent
  const {
    tokens,
    taskType,
    labels,
    labelling,
    untoken,
    docType,
    named,
    runLabel,
    harnessOf,
    fanout,
    runs,
    pickedEffort,
    dependsOn,
    depTasks,
    depKey,
    startFrom,
    fromTask,
    codeTask,
    mergesInto,
    intoKey,
  } = tok
  // What the tokens set, and what a token set (its × takes it out).
  const setBy = (prefix: TokenPrefix) => tokens.some((t) => t.prefix === prefix && t.value !== undefined)
  const removeKind = (prefix: TokenPrefix) => () => untoken((t) => t.prefix === prefix && !(prefix === "/" && isLabelWord(t.value)))
  const typeSet = tokens.some((t) => t.prefix === "/" && t.value !== undefined && !isLabelWord(t.value))
  const typeInfo = typeTabs.find((t) => t.id === taskType)
  const modelLabel = (m: string) => modelList.find((x) => x.id === m)?.label ?? m
  return (
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
        label={noProject ? `No project (${scratch?.name})` : asGroup ? group : project?.name}
        onRemove={setBy("in:") ? removeKind("in:") : undefined}
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
          label={modelLabel(runs[0]?.model || model)}
          title={codex && !runs[0]?.model ? "A Claude model, which Codex doesn't run: it uses the default" : undefined}
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
      {startFrom !== undefined && codeTask && (
        <ReadsChip
          icon={<GitBranch size={12} />}
          label={`from ${startFrom}`}
          title={
            fromTask
              ? `Its worktree starts from ${startFrom}'s branch (${fromTask.title}), which its pull request targets`
              : `Its worktree starts from ${startFrom}`
          }
          onRemove={removeKind("from:")}
          removeTitle="Start from the base branch"
        />
      )}
      {mergesInto && (
        <ReadsChip
          icon={<GitMerge size={12} />}
          label={`into ${intoKey}`}
          title={`Its work merges into ${intoKey}'s branch (${mergesInto.title}), which its pull request targets`}
          onRemove={removeKind("into:")}
          removeTitle="Merge into the base branch"
        />
      )}
      {dependsOn.map((id) => {
        const t = depTasks.find((x) => x.id === id)
        if (!t) return null
        return (
          <ReadsChip
            key={id}
            icon={<Link2 size={12} />}
            label={`after ${depKey(t)}`}
            title={`Its agent starts once ${depKey(t)} (${t.title}) is merged`}
            onRemove={() => untoken((x) => x.prefix === "#" && x.value === depKey(t))}
          />
        )
      })}
    </div>
  )
}
