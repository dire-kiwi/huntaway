import clsx from "clsx";
import { ChevronDown, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { STATUSES } from "../api";
import { baseName, bytes, loadDisk, reclaimable, type Disk, type DProject, type DWorktree } from "../disk";
import { navigate } from "../router";
import { useStore } from "../store";
import { Swatch, useTip } from "./chart";
import { IconButton } from "./ui";

/** How the parts of a project's bar are told apart: by how strong its colour is. */
const PARTS = [
  { id: "repo", label: "Repository", opacity: 1 },
  { id: "worktrees", label: "Worktrees", opacity: 0.6 },
  { id: "runs", label: "Agent runs", opacity: 0.38 },
  { id: "other", label: "Scratch & data", opacity: 0.2 },
] as const;

/** The last measurement, so coming back to the tab doesn't walk every folder again. */
let last: { key: string; data: Disk; at: number } | null = null;

function useDisk() {
  const profilesKey = useStore((s) => s.profiles.map((p) => `${p.host_id}:${p.id}`).join(","));
  const hostsKey = useStore((s) => s.hosts.map((h) => `${h.id}:${h.connected}:${h.api_version}`).join(","));
  const key = `${profilesKey}|${hostsKey}`;
  const cached = last?.key === key ? last : null;
  const [data, setData] = useState<Disk | null>(cached?.data ?? null);
  const [at, setAt] = useState<number | null>(cached?.at ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (nonce === 0 && last?.key === key) {
      setData(last.data);
      setAt(last.at);
      return;
    }
    let cancelled = false;
    setLoading(true);
    loadDisk()
      .then((d) => {
        if (cancelled) return;
        last = { key, data: d, at: Date.now() };
        setData(d);
        setAt(last.at);
        setError(null);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [key, nonce]);
  return { data, at, loading, error, reload: () => setNonce((n) => n + 1) };
}

const statusLabel = (w: DWorktree) => (w.taskId === null ? "No task" : (STATUSES.find((s) => s.id === w.status)?.label ?? ""));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The Disk tab: how much space projects and their worktrees take up. */
export function DiskUsage() {
  const { data, at, loading, error, reload } = useDisk();
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-2">
        <span className="text-[12px] text-faint">
          {loading
            ? "Measuring…"
            : data && at
              ? `Measured at ${new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}, in ${data.elapsedMs < 1000 ? `${data.elapsedMs} ms` : `${(data.elapsedMs / 1000).toFixed(1)}s`}`
              : ""}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <IconButton title="Measure again" onClick={reload}>
            <RefreshCw size={14} className={clsx(loading && "animate-spin")} />
          </IconButton>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl space-y-6 p-6">
          {error && <div className="rounded-md border border-danger/25 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</div>}
          {data?.errors.map((e) => (
            <div key={e} className="rounded-md border border-warning/25 bg-warning/10 px-3 py-2 text-[12.5px] text-warning">
              {e}
            </div>
          ))}
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
            in its worktrees folder that no task on the host has, can usually go: remove a task's worktree from its details.
            Agent runs are the folders with each run's output and logs, which a host removes some days after the run ends, and with its task.
            {data?.filesystems.map((f) => (
              <span key={f.hostName} className="block">
                {f.hostName}'s data disk: {bytes(f.free)} free of {bytes(f.total)}.
                {f.database != null && ` Its database takes ${bytes(f.database)}.`}
                {f.runsKeptDays != null && ` It keeps a run's folder for ${plural(f.runsKeptDays, "day")} after the run ends.`}
              </span>
            ))}
          </p>
        </div>
      </div>
    </>
  );
}

function Tiles({ data }: { data: Disk }) {
  const sum = (f: (p: DProject) => number) => data.projects.reduce((n, p) => n + f(p), 0);
  const repo = sum((p) => p.repo?.bytes ?? 0);
  const git = sum((p) => p.git?.bytes ?? 0);
  const worktrees = data.projects.flatMap((p) => p.worktrees);
  const spare = worktrees.filter(reclaimable);
  const databases = data.filesystems.reduce((n, f) => n + (f.database ?? 0), 0);
  const tile = (label: string, value: string, hint: string, hero = false) => (
    <div className="rounded-lg border border-line bg-panel/60 px-4 py-3">
      <div className="text-[11.5px] text-faint">{label}</div>
      <div className={clsx("mt-1 font-semibold tabular-nums", hero ? "text-[26px] leading-8" : "text-[20px] leading-8")}>{value}</div>
      <div className="mt-0.5 text-[11.5px] text-faint">{hint}</div>
    </div>
  );
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      {tile("Total", bytes(sum((p) => p.total) + data.scratch + data.runs), `${plural(data.projects.length, "project")}, scratch included`, true)}
      {tile("Repositories", bytes(repo), `${bytes(git)} of it in .git`)}
      {tile("Worktrees", bytes(sum((p) => p.worktreeTotal)), plural(worktrees.length, "worktree"))}
      {tile("Agent runs", bytes(sum((p) => p.runs.bytes) + data.runs), databases ? `Output and logs; the database takes ${bytes(databases)}` : "Output and logs")}
      {tile("Reclaimable", bytes(spare.reduce((n, w) => n + w.size.bytes, 0)), `${plural(spare.length, "worktree")} of done tasks or no task`)}
    </div>
  );
}

function PartSwatch({ color, opacity }: { color: string; opacity: number }) {
  return (
    <span className="inline-flex" style={{ opacity }}>
      <Swatch color={color} />
    </span>
  );
}

const partBytes = (p: DProject) => ({
  repo: p.repo?.bytes ?? 0,
  worktrees: p.worktreeTotal,
  runs: p.runs.bytes,
  other: p.other.bytes,
});

/** One bar per project, biggest first, split into its repository, worktrees and the rest. */
function Bars({ projects }: { projects: DProject[] }) {
  const { bind, node } = useTip();
  const max = Math.max(1, ...projects.map((p) => p.total));
  if (projects.length === 0) {
    return <div className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-[12.5px] text-faint">No projects</div>;
  }
  return (
    <section>
      <h2 className="mb-2 text-[13px] font-medium">By project</h2>
      <div className="space-y-1.5 rounded-lg border border-line bg-panel/60 p-4">
        {projects.map((p) => {
          const parts = PARTS.map((part) => ({
            ...part,
            bytes: partBytes(p)[part.id],
          })).filter((x) => x.bytes > 0);
          return (
            <div
              key={`${p.hostId}:${p.id}`}
              className="flex cursor-default items-center gap-3 rounded-sm py-0.5 hover:bg-tint"
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
          );
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
  );
}

function ProjectTable({ data }: { data: Disk }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const manyHosts = new Set(data.projects.map((p) => p.hostId)).size > 1;
  if (data.projects.length === 0) return null;
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
              const id = `${p.hostId}:${p.id}`;
              // With one project there's nothing else to look at, so it starts open.
              const isOpen = open[id] ?? data.projects.length === 1;
              const files = (p.repo?.files ?? 0) + p.worktrees.reduce((n, w) => n + w.size.files, 0) + p.runs.files + p.other.files;
              return (
                <ProjectRows
                  key={id}
                  p={p}
                  open={isOpen}
                  onToggle={() => setOpen({ ...open, [id]: !isOpen })}
                  files={files}
                  host={manyHosts ? p.hostName : null}
                />
              );
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
  );
}

function ProjectRows({ p, open, onToggle, files, host }: { p: DProject; open: boolean; onToggle: () => void; files: number; host: string | null }) {
  const sub = "bg-bg/40";
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
  );
}
