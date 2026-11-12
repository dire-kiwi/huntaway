import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { clsx } from "clsx"
import { Effect, Exit } from "effect"
import { ChevronDown, RefreshCw, Trash2 } from "lucide-react"
import { useState } from "react"
import { mutate, STATUSES } from "@huntaway/client"
import { ProjectId } from "@huntaway/contracts"
import { baseName, bytes, diskAtom, reclaimable, reclaimTargets, type Disk, type DProject, type DWorktree, type Reclaimed } from "./disk"
import { targetsAtom, useGathered } from "./analytics/gather"
import { navigate } from "../../state/route"
import { errorText, exitError, useAction } from "../../state/mutation"
import { Swatch, useTip } from "./chart"
import { Button, ConfirmModal, IconButton, localeTimeString } from "../ui"

/** How the parts of a project's bar are told apart: by how strong its colour is. */
const PARTS = [
  { id: "repo", label: "Repository", opacity: 1 },
  { id: "worktrees", label: "Worktrees", opacity: 0.6 },
  { id: "runs", label: "Agent runs", opacity: 0.38 },
  { id: "other", label: "Scratch & data", opacity: 0.2 },
] as const

/** The last measurement of `profile`'s projects on the connected hosts (the one before while another is first made). */
function useDisk(profile: string | null) {
  const targets = useAtomValue(targetsAtom(profile))
  const atom = diskAtom({ profile, targets })
  const { data, loading } = useGathered(atom)
  const reload = useAtomRefresh(atom)
  return { data: data?.disk ?? null, at: data?.at ?? null, loading, reload }
}

const statusLabel = (w: DWorktree) => (w.taskId === null ? "No task" : (STATUSES.find((s) => s.id === w.status)?.label ?? ""))
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The Disk tab: how much space projects and their worktrees take up, `profile`'s or, when it's null, every profile's. */
export function DiskUsage({ profile = null }: { profile?: string | null }) {
  const { data, at, loading, reload } = useDisk(profile)
  const [confirming, setConfirming] = useState(false)
  const [reclaimed, setReclaimed] = useState<{ results: Reclaimed[]; errors: string[] } | null>(null)
  const [, run] = useAction()
  const targets = data ? reclaimTargets(data) : []
  // Removes the done tasks' worktrees that are merged and clean; the hosts it ran on measure again (invalidate.ts).
  const reclaim = () =>
    run(
      Effect.forEach(
        targets,
        (p) =>
          mutate("projects.removeMergedWorktrees", p.hostId, { id: ProjectId.make(p.id) }).pipe(
            Effect.map((removed) => ({
              results: removed.map((r): Reclaimed => {
                const w = p.worktrees.find((x) => x.taskId === r.task_id)
                return { taskId: r.task_id, key: w?.key ?? `#${r.number}`, title: r.title, removed: r.removed, detail: r.detail, bytes: w?.size.bytes ?? 0 }
              }),
              error: null,
            })),
            Effect.catch((e) => Effect.succeed({ results: [], error: `${p.name}: ${errorText(e)}` })),
          ),
        { concurrency: "unbounded" },
      ),
    ).then((exit) => {
      const failed = exitError(exit)
      if (failed !== null) throw new Error(failed)
      if (Exit.isSuccess(exit)) {
        setReclaimed({ results: exit.value.flatMap((r) => r.results), errors: exit.value.flatMap((r) => (r.error === null ? [] : [r.error])) })
      }
    })
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-2">
        <span className="text-[12px] text-faint">
          {loading
            ? "Measuring…"
            : data && at
              ? `Measured at ${localeTimeString(at, { hour: "numeric", minute: "2-digit" }, [])}, in ${data.elapsedMs < 1000 ? `${data.elapsedMs} ms` : `${(data.elapsedMs / 1000).toFixed(1)}s`}`
              : ""}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" disabled={loading || targets.length === 0} onClick={() => setConfirming(true)}>
            <Trash2 size={12} /> Reclaim space
          </Button>
          <IconButton title="Measure again" onClick={reload}>
            <RefreshCw size={14} className={clsx(loading && "animate-spin")} />
          </IconButton>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl space-y-6 p-6">
          {data?.errors.map((e) => (
            <div key={e} className="rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[12.5px] text-amber-200">
              {e}
            </div>
          ))}
          {reclaimed && <ReclaimedList reclaimed={reclaimed} onClose={() => setReclaimed(null)} />}
          {data && (
            <>
              <Tiles data={data} />
              <Bars projects={data.projects} />
              <ProjectTable data={data} />
            </>
          )}
          <p className="text-[11.5px] leading-relaxed text-faint">
            Sizes are the space files take up on disk, as <span className="font-mono">du</span> counts them. Worktrees share their repository's{" "}
            <span className="font-mono">.git</span> folder, which counts toward the repository. Worktrees of done tasks, and worktrees of a project's repository
            in its worktrees folder that no task on the host has, can usually go: Reclaim space removes the merged, clean worktrees of done tasks, or remove a
            task's worktree from its details. Agent runs are the folders with each run's output and logs, which a host removes some days after the run ends, and
            with its task.
            {profile !== null && " A host's database and its backups hold every profile's data, so they're counted under All."}
            {data?.filesystems.map((f) => (
              <span key={f.hostName} className="block">
                {f.hostName}'s data disk: {bytes(f.free)} free of {bytes(f.total)}.{f.database != null && ` Its database takes ${bytes(f.database)}.`}
                {f.backups != null &&
                  f.backups.files > 0 &&
                  ` ${f.backups.files === 1 ? "A backup of it, made when its version changed, takes" : `${f.backups.files} backups of it, made when its version changed, take`} ${bytes(f.backups.bytes)} (in the backups folder of its data dir, where older ones can be deleted).`}
                {f.runsKeptDays != null && ` It keeps a run's folder for ${plural(f.runsKeptDays, "day")} after the run ends.`}
              </span>
            ))}
          </p>
        </div>
      </div>
      {confirming && (
        <ConfirmModal
          title="Reclaim space"
          width="max-w-lg"
          body={
            <>
              <p>
                Removes the worktrees of done tasks in {plural(targets.length, "project")} whose work is merged and that have no uncommitted or untracked files
                (ignored files, such as build output, go with them). The tasks and branches are kept, and a task's worktree is set up again if its agent runs
                again.
              </p>
              <p>Worktrees that aren't merged, or that have changes in them, are left alone and listed with the reason.</p>
            </>
          }
          action="Reclaim space"
          danger
          onConfirm={reclaim}
          onClose={() => setConfirming(false)}
        />
      )}
    </>
  )
}

/** What reclaiming removed, how much that frees, and what it kept and why. */
function ReclaimedList({ reclaimed, onClose }: { reclaimed: { results: Reclaimed[]; errors: string[] }; onClose: () => void }) {
  const { results, errors } = reclaimed
  const removed = results.filter((r) => r.removed)
  return (
    <div className="space-y-2 rounded-md border border-line bg-panel/60 px-3 py-2 text-[12.5px]">
      <div className="flex items-center gap-2">
        <span className="font-medium">
          {results.length === 0 ? "No done tasks have worktrees." : `Removed ${removed.length}, kept ${results.length - removed.length}`}
          {removed.length > 0 && `, freeing ${bytes(removed.reduce((n, r) => n + r.bytes, 0))}`}
        </span>
        <button className="ml-auto text-[11.5px] text-faint hover:text-fg" onClick={onClose}>
          Dismiss
        </button>
      </div>
      {errors.map((e) => (
        <div key={e} className="text-red-300">
          {e}
        </div>
      ))}
      <ul className="space-y-0.5 text-[12px]">
        {results.map((r) => (
          <li key={r.taskId} className="flex gap-2">
            <span className={clsx("shrink-0 font-mono", r.removed ? "text-emerald-400" : "text-faint")}>{r.key}</span>
            <span className="min-w-0 truncate">{r.title}</span>
            <span className="ml-auto max-w-[55%] shrink-0 truncate text-faint" title={r.detail}>
              {r.removed ? `removed, ${bytes(r.bytes)}` : `kept: ${r.detail}`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

const tile = (label: string, value: string, hint: string, hero = false) => (
  <div className="rounded-lg border border-line bg-panel/60 px-4 py-3">
    <div className="text-[11.5px] text-faint">{label}</div>
    <div className={clsx("mt-1 font-semibold tabular-nums", hero ? "text-[26px] leading-8" : "text-[20px] leading-8")}>{value}</div>
    <div className="mt-0.5 text-[11.5px] text-faint">{hint}</div>
  </div>
)

function Tiles({ data }: { data: Disk }) {
  const sum = (f: (p: DProject) => number) => data.projects.reduce((n, p) => n + f(p), 0)
  const repo = sum((p) => p.repo?.bytes ?? 0)
  const git = sum((p) => p.git?.bytes ?? 0)
  const worktrees = data.projects.flatMap((p) => p.worktrees)
  const spare = worktrees.filter(reclaimable)
  const databases = data.filesystems.reduce((n, f) => n + (f.database ?? 0), 0)
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      {tile("Total", bytes(sum((p) => p.total) + data.scratch + data.runs), `${plural(data.projects.length, "project")}, scratch included`, true)}
      {tile("Repositories", bytes(repo), `${bytes(git)} of it in .git`)}
      {tile("Worktrees", bytes(sum((p) => p.worktreeTotal)), plural(worktrees.length, "worktree"))}
      {tile(
        "Agent runs",
        bytes(sum((p) => p.runs.bytes) + data.runs),
        databases ? `Output and logs; the database takes ${bytes(databases)}` : "Output and logs",
      )}
      {tile("Reclaimable", bytes(spare.reduce((n, w) => n + w.size.bytes, 0)), `${plural(spare.length, "worktree")} of done tasks or no task`)}
    </div>
  )
}

function PartSwatch({ color, opacity }: { color: string; opacity: number }) {
  return (
    <span className="inline-flex" style={{ opacity }}>
      <Swatch color={color} />
    </span>
  )
}

const partBytes = (p: DProject) => ({
  repo: p.repo?.bytes ?? 0,
  worktrees: p.worktreeTotal,
  runs: p.runs.bytes,
  other: p.other.bytes,
})

/** One bar per project, biggest first, split into its repository, worktrees and the rest. */
function Bars({ projects }: { projects: DProject[] }) {
  const { bind, node } = useTip()
  const max = Math.max(1, ...projects.map((p) => p.total))
  if (projects.length === 0) {
    return <div className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-[12.5px] text-faint">No projects</div>
  }
  return (
    <section>
      <h2 className="mb-2 text-[13px] font-medium">By project</h2>
      <div className="space-y-1.5 rounded-lg border border-line bg-panel/60 p-4">
        {projects.map((p) => {
          const parts = PARTS.map((part) => ({
            ...part,
            bytes: partBytes(p)[part.id],
          })).filter((x) => x.bytes > 0)
          return (
            <div
              key={`${p.hostId}:${p.id}`}
              className="flex cursor-default items-center gap-3 rounded-sm py-0.5 hover:bg-white/[0.03]"
              {...bind(() => (
                <>
                  <div className="mb-1 flex items-center gap-1.5 font-medium">
                    <Swatch color={p.color} /> {p.name}
                  </div>
                  {PARTS.map((part) => (
                    <div key={part.id} className="flex items-center gap-1.5">
                      <PartSwatch color={p.color} opacity={part.opacity} />
                      <span className="min-w-0 flex-1 text-muted">{part.label}</span>
                      <span className="pl-3 tabular-nums">{bytes(partBytes(p)[part.id])}</span>
                    </div>
                  ))}
                  <div className="mt-1 border-t border-line pt-1 text-right tabular-nums">{bytes(p.total)}</div>
                </>
              ))}
            >
              <span className="w-40 shrink-0 truncate text-[12px] text-muted">{p.name}</span>
              <div className="flex h-3.5 min-w-0 flex-1">
                <div className="flex h-full gap-[2px]" style={{ width: `${(p.total * 100) / max}%` }}>
                  {parts.map((part, i) => (
                    <div
                      key={part.id}
                      className={clsx("h-full", i === parts.length - 1 && "rounded-r-[4px]")}
                      style={{
                        flex: part.bytes,
                        minWidth: 2,
                        background: p.color,
                        opacity: part.opacity,
                      }}
                    />
                  ))}
                </div>
              </div>
              <span className="w-16 shrink-0 text-right text-[12px] tabular-nums">{bytes(p.total)}</span>
            </div>
          )
        })}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-2 text-[11.5px] text-muted">
          {PARTS.map((part) => (
            <span key={part.id} className="flex items-center gap-1.5">
              <PartSwatch color="#c8c8d0" opacity={part.opacity} /> {part.label}
            </span>
          ))}
          <span className="text-faint">in each project's colour</span>
        </div>
      </div>
      {node}
    </section>
  )
}

function ProjectTable({ data }: { data: Disk }) {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const manyHosts = new Set(data.projects.map((p) => p.hostId)).size > 1
  if (data.projects.length === 0) return null
  return (
    <section>
      <h2 className="mb-2 text-[13px] font-medium">Projects and worktrees</h2>
      <div className="overflow-hidden rounded-lg border border-line">
        <table className="w-full text-[12.5px]">
          <thead className="bg-panel text-left text-[11.5px] text-faint">
            <tr>
              <th className="px-3 py-2 font-normal">Folder</th>
              <th className="hidden w-36 px-3 py-2 font-normal md:table-cell">Task status</th>
              <th className="w-24 px-3 py-2 text-right font-normal">Files</th>
              <th className="w-24 px-3 py-2 text-right font-normal">Size</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {data.projects.map((p) => {
              const id = `${p.hostId}:${p.id}`
              // With one project there's nothing else to look at, so it starts open.
              const isOpen = open[id] ?? data.projects.length === 1
              const files = (p.repo?.files ?? 0) + p.worktrees.reduce((n, w) => n + w.size.files, 0) + p.runs.files + p.other.files
              return (
                <ProjectRows
                  key={id}
                  p={p}
                  open={isOpen}
                  onToggle={() => setOpen({ ...open, [id]: !isOpen })}
                  files={files}
                  host={manyHosts ? p.hostName : null}
                />
              )
            })}
            {data.scratch > 0 && (
              <tr className="bg-panel/60">
                <td className="px-3 py-2 pl-9 text-muted">Group tasks and old scratch chats</td>
                <td className="hidden md:table-cell" />
                <td />
                <td className="px-3 py-2 text-right tabular-nums">{bytes(data.scratch)}</td>
              </tr>
            )}
            {data.runs > 0 && (
              <tr className="bg-panel/60">
                <td className="px-3 py-2 pl-9 text-muted">Agent runs of group tasks and scratch chats</td>
                <td className="hidden md:table-cell" />
                <td />
                <td className="px-3 py-2 text-right tabular-nums">{bytes(data.runs)}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function ProjectRows({ p, open, onToggle, files, host }: { p: DProject; open: boolean; onToggle: () => void; files: number; host: string | null }) {
  const sub = "bg-bg/40"
  return (
    <>
      <tr className="cursor-pointer bg-panel/60 hover:bg-raised" onClick={onToggle}>
        <td className="px-3 py-2">
          <span className="flex items-center gap-2">
            <ChevronDown size={13} className={clsx("text-faint transition-transform", !open && "-rotate-90")} />
            <Swatch color={p.color} />
            <span className="font-medium">{p.name}</span>
            {host && <span className="text-[11.5px] text-faint">on {host}</span>}
            <span className="text-[11.5px] text-faint">{plural(p.worktrees.length, "worktree")}</span>
          </span>
        </td>
        <td className="hidden md:table-cell" />
        <td className="px-3 py-2 text-right tabular-nums text-muted">{files.toLocaleString()}</td>
        <td className="px-3 py-2 text-right font-medium tabular-nums">{bytes(p.total)}</td>
      </tr>
      {open && (
        <>
          <tr className={sub} title={p.repoPath}>
            <td className="py-1.5 pr-3 pl-9">
              Repository <span className="ml-1 font-mono text-[11.5px] text-faint">{p.repoPath}</span>
              {p.git && <span className="ml-2 text-[11.5px] text-faint">· {bytes(p.git.bytes)} in .git</span>}
            </td>
            <td className="hidden md:table-cell" />
            <td className="px-3 py-1.5 text-right tabular-nums text-muted">{p.repo ? p.repo.files.toLocaleString() : ""}</td>
            <td className="px-3 py-1.5 text-right tabular-nums">{p.repo ? bytes(p.repo.bytes) : <span className="text-faint italic">Missing</span>}</td>
          </tr>
          {p.worktrees.map((w) => (
            <tr
              key={w.path}
              title={w.path}
              className={clsx(sub, w.taskId && "cursor-pointer hover:bg-raised")}
              onClick={() => w.taskId && navigate({ name: "task", taskId: w.taskId })}
            >
              <td className="py-1.5 pr-3 pl-9">
                {w.taskId ? (
                  <>
                    <span className="mr-2 font-mono text-[11.5px] text-faint">{w.key}</span>
                    {w.title || "Untitled"}
                  </>
                ) : (
                  <span className="font-mono text-[11.5px] text-muted">{baseName(w.path)}</span>
                )}
              </td>
              <td className={clsx("hidden px-3 py-1.5 md:table-cell", reclaimable(w) ? "text-faint italic" : "text-muted")}>{statusLabel(w)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-muted">{w.size.files.toLocaleString()}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{bytes(w.size.bytes)}</td>
            </tr>
          ))}
          {p.runs.bytes > 0 && (
            <tr className={sub}>
              <td className="py-1.5 pr-3 pl-9 text-muted">Agent runs' output and logs</td>
              <td className="hidden md:table-cell" />
              <td className="px-3 py-1.5 text-right tabular-nums text-muted">{p.runs.files.toLocaleString()}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{bytes(p.runs.bytes)}</td>
            </tr>
          )}
          {p.other.bytes > 0 && (
            <tr className={sub}>
              <td className="py-1.5 pr-3 pl-9 text-muted">Scratch folder and project data</td>
              <td className="hidden md:table-cell" />
              <td className="px-3 py-1.5 text-right tabular-nums text-muted">{p.other.files.toLocaleString()}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{bytes(p.other.bytes)}</td>
            </tr>
          )}
        </>
      )}
    </>
  )
}
