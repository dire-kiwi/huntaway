// The compare view (HA-51): the tasks made from one prompt (see Fanout.tsx), each with its model, state, cost, agent
// time, review and diff against its base branch, side by side or one at a time (as the Changes tab shows a diff), and
// "Pick this one", which keeps it and completes the others as not done, removing their worktrees, and their branches and
// pull requests if asked. It opens over the page (`?task=<id>&compare`, see router.ts) from a card's model badge or
// menu, or the task's details. The narrow layout shows them one at a time.
import clsx from "clsx";
import { AlertTriangle, ChevronDown, ChevronRight, Columns3, GitCompareArrows, Loader2, PanelTop, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, STATUSES, type DiffResult, type FanoutFacts, type PickOutcome, type Task } from "../api";
import { parseDiff, type FileDiff } from "../changes";
import { useNarrow } from "../narrow";
import { closeCompare, openTask } from "../router";
import { taskKey, useStore } from "../store";
import { BranchView, LayoutToggle } from "./Changes";
import type { Layout } from "./DiffLines";
import { harnessLabels, useConfigsOf, useFanout } from "./Fanout";
import { ReviewVerdict } from "./Review";
import { Button, cost, duration, errorText, IconButton, Modal, ModalFooter, PrIcon, RESOLUTION_LABELS, RunningDot, StatusIcon, useClock } from "./ui";

/** Side by side or one at a time, kept in this browser. */
type Mode = "side" | "one";
const MODE_KEY = "ia.compare.mode";
/** The Changes tab's unified or split diffs, which one at a time follows. */
const LAYOUT_KEY = "ia.changes.layout";

const statusLabel = (t: Task) => (t.status === "done" && t.resolution ? RESOLUTION_LABELS[t.resolution] : (STATUSES.find((s) => s.id === t.status)?.label ?? t.status));
const notDone = (t: Task) => t.status === "done" && t.resolution === "not_done";
const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
const stat = (files: FileDiff[]) => ({ files: files.length, adds: files.reduce((a, f) => a + f.adds, 0), dels: files.reduce((a, f) => a + f.dels, 0) });

export default function CompareView({ taskId }: { taskId: string }) {
  const task = useStore((s) => s.tasks[taskId]);
  const loaded = useStore((s) => s.loaded);
  return (
    <Overlay>
      {task?.fanout_id ? (
        <Compare task={task} />
      ) : (
        <>
          <Header title="Compare" />
          <div className="p-6 text-[13px] text-muted">{loaded && (task ? "This task wasn't made from one prompt with others." : "This task isn't on the board.")}</div>
        </>
      )}
    </Overlay>
  );
}

/** Over the whole page; Escape closes it (unless a dialog in it is open). `data-modal` keeps the task panel's keys and clicks off it. */
function Overlay({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || ref.current?.querySelector("[data-modal]")) return;
      if ((e.target as Element).closest?.("input, textarea, select, [contenteditable]")) return;
      // Not the task panel's Escape too, once this has gone.
      e.preventDefault();
      closeCompare();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div ref={ref} data-modal data-compare className="fixed inset-0 z-50 flex flex-col bg-bg pt-[env(safe-area-inset-top)]">
      {children}
    </div>
  );
}

function Header({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2 narrow:px-2">
      <GitCompareArrows size={15} className="shrink-0 text-accent" />
      <div className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">{title}</div>
      {children}
      <IconButton title="Close (Esc)" aria-label="Close" onClick={closeCompare}>
        <X size={16} />
      </IconButton>
    </div>
  );
}

/** The facts the host has of each (API 81): fetched again when one of them changes, and when asked. */
function useFacts(task: Task, tasks: Task[], tick: number) {
  const [facts, setFacts] = useState<{ byId: Record<string, FanoutFacts>; at: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sig = tasks.map((t) => `${t.id}:${t.status}:${t.running}:${t.worktree_state}`).join(",");
  useEffect(() => {
    let live = true;
    api.fanout(task.host_id, task.id).then(
      (r) => live && (setFacts({ byId: Object.fromEntries(r.tasks.map((f) => [f.id, f])), at: Date.now() }), setError(null)),
      (e) => live && setError(errorText(e)),
    );
    return () => void (live = false);
  }, [task.host_id, task.id, sig, tick]);
  return { facts, error };
}

/** Each one's diff against its base branch, fetched again when it changes (its agent finished, its worktree went) and when asked. */
function useDiffs(tasks: Task[], tick: number) {
  const [diffs, setDiffs] = useState<Record<string, DiffResult>>({});
  const asked = useRef<Record<string, string>>({});
  const latest = useRef<Record<string, number>>({});
  const keyOf = (t: Task) => `${t.id}:${t.status}:${t.running}:${t.worktree_state}:${t.branch}:${tick}`;
  const sig = tasks.map(keyOf).join(",");
  useEffect(() => {
    for (const t of tasks) {
      if (asked.current[t.id] === keyOf(t)) continue;
      asked.current[t.id] = keyOf(t);
      const n = (latest.current[t.id] ?? 0) + 1;
      latest.current[t.id] = n;
      const set = (d: DiffResult) => latest.current[t.id] === n && setDiffs((m) => ({ ...m, [t.id]: d }));
      api.diff(t.host_id, t.id).then(set, (e) => set({ available: false, reason: errorText(e) }));
    }
    // What it reads of `tasks` is in `sig`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  return diffs;
}

function Compare({ task }: { task: Task }) {
  const tasks = useFanout(task);
  const configs = useConfigsOf(tasks);
  const labels = harnessLabels(tasks, configs);
  const projects = useStore((s) => s.projects);
  const narrow = useNarrow();
  const [modeChoice, setModeChoice] = useState<Mode>(() => (localStorage.getItem(MODE_KEY) === "one" ? "one" : "side"));
  const mode: Mode = narrow ? "one" : modeChoice;
  const setMode = (m: Mode) => {
    localStorage.setItem(MODE_KEY, m);
    setModeChoice(m);
  };
  const [layout, setLayout] = useState<Layout>(() => (localStorage.getItem(LAYOUT_KEY) === "split" ? "split" : "unified"));
  const toggleLayout = () => {
    const l = layout === "split" ? "unified" : "split";
    localStorage.setItem(LAYOUT_KEY, l);
    setLayout(l);
  };
  const [tick, setTick] = useState(0);
  const { facts, error } = useFacts(task, tasks, tick);
  const diffs = useDiffs(tasks, tick);
  const files = useMemo(() => Object.fromEntries(Object.entries(diffs).map(([id, d]) => [id, d.available ? parseDiff(d.patch ?? "") : []])), [diffs]);
  const [shownId, setShown] = useState(task.id);
  const shown = tasks.find((t) => t.id === shownId) ?? tasks[0];
  const [picking, setPicking] = useState<Task | null>(null);
  const keyOf = (t: Task) => taskKey(t, projects);
  const labelOf = (t: Task) => labels[tasks.indexOf(t)] ?? "";

  // One at a time: ←/→ (or [ and ]) go to the one before or after, 1–9 to one.
  const move = useCallback(
    (by: number) => setShown((id) => tasks[(tasks.findIndex((t) => t.id === id) + by + tasks.length) % tasks.length]?.id ?? id),
    [tasks],
  );
  useEffect(() => {
    if (mode !== "one") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || document.querySelector("[data-compare] [data-modal]")) return;
      if ((e.target as Element).closest?.("input, textarea, select, [contenteditable]")) return;
      if (e.key === "ArrowRight" || e.key === "]") move(1);
      else if (e.key === "ArrowLeft" || e.key === "[") move(-1);
      else if (/^[1-9]$/.test(e.key) && tasks[+e.key - 1]) setShown(tasks[+e.key - 1].id);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, move, tasks]);

  // A file picked in the overview: its diff scrolled to, in its column or once it's the one shown.
  const body = useRef<HTMLDivElement>(null);
  const [goTo, setGoTo] = useState<{ id: string; path: string } | null>(null);
  const openFile = (id: string, path: string) => {
    if (mode === "one") setShown(id);
    setGoTo({ id, path });
  };
  useEffect(() => {
    if (!goTo) return;
    const el = body.current?.querySelector(`[data-sibling="${CSS.escape(goTo.id)}"] [data-file="${CSS.escape(goTo.path)}"]`);
    el?.scrollIntoView({ block: "start" });
    setGoTo(null);
  }, [goTo, shownId]);

  const running = tasks.some((t) => t.running);
  const summary = (t: Task, wide?: boolean) => (
    <Summary
      t={t}
      taskKey={keyOf(t)}
      label={labelOf(t)}
      facts={facts?.byId[t.id]}
      factsAt={facts?.at ?? 0}
      ticking={running}
      diff={diffs[t.id]}
      files={files[t.id]}
      picked={!notDone(t) && tasks.every((o) => o === t || notDone(o))}
      onPick={() => setPicking(t)}
      wide={wide}
    />
  );
  const diffOf = (t: Task, l: Layout) => (
    <div data-sibling={t.id} className="min-w-0 bg-bg p-2 font-mono text-[12px] leading-[18px]">
      {diffs[t.id] ? (
        <BranchView diff={diffs[t.id]} layout={l} />
      ) : (
        <div className="flex items-center gap-2 px-1.5 font-sans text-faint">
          <Loader2 size={12} className="animate-spin" /> Loading the diff…
        </div>
      )}
    </div>
  );

  return (
    <>
      <Header
        title={
          <>
            Compare {tasks.length} tasks from one prompt <span className="font-normal text-muted narrow:hidden">· {task.title}</span>
          </>
        }
      >
        {!narrow && (
          <div className="flex shrink-0 rounded-md border border-line p-0.5 text-[12px]" role="group" aria-label="How to show them">
            {(
              [
                ["side", "Side by side", <Columns3 key="i" size={13} />],
                ["one", "One at a time", <PanelTop key="i" size={13} />],
              ] as const
            ).map(([m, label, icon]) => (
              <button
                key={m}
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
                className={clsx("flex items-center gap-1.5 rounded px-2 py-0.5", mode === m ? "bg-white/10 text-fg" : "text-muted hover:text-fg")}
              >
                {icon} {label}
              </button>
            ))}
          </div>
        )}
        {mode === "one" && !narrow && (
          <span className="shrink-0 font-mono text-[11.5px]">
            <LayoutToggle layout={layout} onToggle={toggleLayout} />
          </span>
        )}
        <IconButton title="Load the diffs again" aria-label="Load the diffs again" onClick={() => setTick((n) => n + 1)}>
          <RefreshCw size={14} />
        </IconButton>
      </Header>
      {error && <div className="shrink-0 border-b border-line bg-red-500/10 px-4 py-1.5 text-[12px] text-red-300">{error}</div>}
      {tasks.length < 2 ? (
        <div className="p-6 text-[13px] text-muted">The other tasks made from this prompt aren't on the board any more.</div>
      ) : mode === "side" ? (
        <div ref={body} className="flex min-h-0 flex-1 flex-col">
          <FilesOverview tasks={tasks} taskKey={keyOf} files={files} onOpen={openFile} />
          <div className="flex min-h-0 flex-1 overflow-x-auto">
            {tasks.map((t) => (
              <section key={t.id} aria-label={keyOf(t)} className="flex min-w-[420px] flex-1 basis-0 flex-col border-r border-line last:border-r-0">
                <div className="max-h-[45%] shrink-0 overflow-y-auto border-b border-line">{summary(t)}</div>
                <div className="min-h-0 flex-1 overflow-auto">{diffOf(t, "unified")}</div>
              </section>
            ))}
          </div>
        </div>
      ) : (
        <div ref={body} className="flex min-h-0 flex-1 flex-col narrow:overflow-y-auto">
          <div role="tablist" aria-label="Tasks" className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-line px-3 py-2 [scrollbar-width:none]">
            {tasks.map((t, i) => {
              const s = stat(files[t.id] ?? []);
              return (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={t.id === shown.id}
                  title={`${keyOf(t)} · ${labelOf(t)}${i < 9 ? ` (${i + 1})` : ""}`}
                  onClick={() => setShown(t.id)}
                  className={clsx(
                    "flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[12.5px] narrow:h-9",
                    t.id === shown.id ? "border-accent/50 bg-accent/10 text-fg" : "border-line text-muted hover:text-fg",
                  )}
                >
                  <StatusIcon status={t.status} size={12} />
                  <span className="font-mono text-[11px] text-faint">{keyOf(t)}</span>
                  {labelOf(t)}
                  {t.running && <RunningDot />}
                  {diffs[t.id]?.available && (
                    <span className="text-[11px]">
                      <span className="text-emerald-400">+{s.adds}</span> <span className="text-red-400">−{s.dels}</span>
                    </span>
                  )}
                </button>
              );
            })}
            {!narrow && <span className="ml-auto shrink-0 self-center text-[11px] text-faint">← → to switch</span>}
          </div>
          {!narrow && <FilesOverview tasks={tasks} taskKey={keyOf} files={files} onOpen={openFile} current={shown.id} />}
          {/* Narrow, the page scrolls down through both, and the diff sideways. */}
          <div className="flex min-h-0 flex-1 narrow:flex-none narrow:flex-col">
            <div className="w-[340px] shrink-0 overflow-y-auto border-r border-line narrow:w-auto narrow:border-r-0 narrow:border-b">{summary(shown, true)}</div>
            <div className="min-h-0 min-w-0 flex-1 overflow-auto narrow:flex-none narrow:overflow-y-hidden">{diffOf(shown, narrow ? "unified" : layout)}</div>
          </div>
        </div>
      )}
      {picking && (
        <PickDialog
          picked={picking}
          others={tasks.filter((t) => t.id !== picking.id)}
          taskKey={keyOf}
          labelOf={labelOf}
          onClose={() => setPicking(null)}
          onPicked={() => setTick((n) => n + 1)}
        />
      )}
    </>
  );
}

/** One of them: what it ran with, where it is, what it cost and took, what it changed, its review, and its buttons. */
function Summary({
  t,
  taskKey: key,
  label,
  facts,
  factsAt,
  ticking,
  diff,
  files,
  picked,
  onPick,
  wide,
}: {
  t: Task;
  taskKey: string;
  label: string;
  facts: FanoutFacts | undefined;
  factsAt: number;
  ticking: boolean;
  diff: DiffResult | undefined;
  files: FileDiff[] | undefined;
  picked: boolean;
  onPick: () => void;
  wide?: boolean;
}) {
  // A running agent's time goes on counting from when the host said.
  const now = useClock(ticking ? 1000 : 3_600_000);
  const secs = facts ? facts.run_secs + (t.running ? Math.max(0, now - factsAt) / 1000 : 0) : null;
  const s = stat(files ?? []);
  const commits = diff?.commits?.trim() ? diff.commits.trim().split("\n").length : 0;
  return (
    <div className="space-y-2.5 p-3 text-[12.5px]">
      <div className="flex items-center gap-2">
        <StatusIcon status={t.status} />
        <span className="shrink-0 font-mono text-[11.5px] text-faint">{key}</span>
        <span className="min-w-0 truncate text-[13.5px] font-semibold text-fg" title={label}>
          {label}
        </span>
        {t.running && <RunningDot />}
        {picked && <span className="shrink-0 rounded-full bg-emerald-500/15 px-2 text-[11px] text-emerald-300">Picked</span>}
      </div>
      <dl className={clsx("grid gap-x-3 gap-y-1", wide ? "grid-cols-[auto_1fr]" : "grid-cols-[auto_1fr_auto_1fr]")}>
        <Fact label="Status">{statusLabel(t)}</Fact>
        <Fact label="Cost">{cost(t.cost_usd) ?? "—"}</Fact>
        <Fact label="Agent time">
          {secs === null ? (
            "…"
          ) : (
            <span title={facts ? `${plural(facts.runs, "run")}, all together` : undefined}>
              {secs >= 1 ? duration(secs * 1000) : secs > 0 ? "<1s" : "—"}
              {facts && facts.runs > 1 && <span className="text-faint"> · {plural(facts.runs, "run")}</span>}
            </span>
          )}
        </Fact>
        <Fact label="Changes">
          {!diff ? (
            "…"
          ) : !diff.available ? (
            <span className="text-faint">none to show</span>
          ) : (
            <span>
              {plural(s.files, "file")} <span className="text-emerald-400">+{s.adds}</span> <span className="text-red-400">−{s.dels}</span>
              {commits > 0 && <span className="text-faint"> · {plural(commits, "commit")}</span>}
            </span>
          )}
        </Fact>
        {facts && facts.uncommitted_count > 0 && (
          <Fact label="Uncommitted">
            <span className="text-amber-300" title={facts.uncommitted.join("\n")}>
              {plural(facts.uncommitted_count, "file")}
            </span>
          </Fact>
        )}
        {t.pr_url && (
          <Fact label="Pull request">
            <PrIcon url={t.pr_url} label />
          </Fact>
        )}
      </dl>
      <div>
        <div className="mb-1 text-[11px] font-medium tracking-wide text-faint uppercase">Review</div>
        <ReviewVerdict task={t} />
      </div>
      <div className="flex flex-wrap gap-2 pt-0.5">
        <Button size="sm" variant="ghost" onClick={() => openTask(t.id)}>
          Open
        </Button>
        {!notDone(t) && (
          <Button size="sm" variant="primary" onClick={onPick} title={`Keep ${key}, and complete the others as Not done`}>
            Pick this one
          </Button>
        )}
      </div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-faint">{label}</dt>
      <dd className="min-w-0 truncate text-fg">{children}</dd>
    </>
  );
}

/**
 * The files any of them changed, and how much each one changed them: to see where they differ, and go to a file's
 * diff. Folded away once there are many.
 */
function FilesOverview({
  tasks,
  taskKey: key,
  files,
  onOpen,
  current,
}: {
  tasks: Task[];
  taskKey: (t: Task) => string;
  files: Record<string, FileDiff[]>;
  onOpen: (id: string, path: string) => void;
  current?: string;
}) {
  const paths = useMemo(() => [...new Set(tasks.flatMap((t) => (files[t.id] ?? []).map((f) => f.path)))].sort(), [tasks, files]);
  const [open, setOpen] = useState<boolean | null>(null);
  if (!paths.length) return null;
  const isOpen = open ?? paths.length <= 12;
  return (
    <div className="shrink-0 border-b border-line">
      <button onClick={() => setOpen(!isOpen)} className="flex w-full items-center gap-1.5 px-4 py-1.5 text-left text-[12px] text-muted hover:text-fg">
        {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {plural(paths.length, "file")} changed between them
      </button>
      {isOpen && (
        <div className="max-h-48 overflow-auto px-4 pb-2">
          <table className="font-mono text-[11.5px]">
            <thead>
              <tr className="text-left text-faint">
                <th className="pr-4 font-normal">File</th>
                {tasks.map((t) => (
                  <th key={t.id} className={clsx("px-2 font-normal", t.id === current && "text-fg")}>
                    {key(t)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {paths.map((p) => (
                <tr key={p} className="hover:bg-white/[0.03]">
                  <td className="max-w-[40vw] truncate pr-4 text-muted" title={p}>
                    {p}
                  </td>
                  {tasks.map((t) => {
                    const f = files[t.id]?.find((f) => f.path === p);
                    return (
                      <td key={t.id} className="px-2 whitespace-nowrap">
                        {f ? (
                          <button className="hover:underline" title={`${key(t)}: go to its diff of ${p}`} onClick={() => onOpen(t.id, p)}>
                            <span className="text-emerald-400">+{f.adds}</span> <span className="text-red-400">−{f.dels}</span>
                          </button>
                        ) : (
                          <span className="text-faint">·</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Asks before picking one: what happens to each of the others (stopped, completed as not done, its worktree removed),
 * with what would be lost said, and whether to discard uncommitted changes, delete their branches and close their pull
 * requests. Then says what was done, if anything didn't go as asked.
 */
function PickDialog({
  picked,
  others,
  taskKey: key,
  labelOf,
  onClose,
  onPicked,
}: {
  picked: Task;
  others: Task[];
  taskKey: (t: Task) => string;
  labelOf: (t: Task) => string;
  onClose: () => void;
  onPicked: () => void;
}) {
  const [facts, setFacts] = useState<Record<string, FanoutFacts> | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [discard, setDiscard] = useState(false);
  const [deleteBranches, setDeleteBranches] = useState(false);
  const [closePrs, setClosePrs] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [results, setResults] = useState<PickOutcome[] | null>(null);
  // What's uncommitted, running or pushed now, not as of when the view opened.
  useEffect(() => {
    api.fanout(picked.host_id, picked.id).then(
      (r) => setFacts(Object.fromEntries(r.tasks.map((f) => [f.id, f]))),
      (e) => setLoadErr(errorText(e)),
    );
  }, [picked.host_id, picked.id]);
  const f = (t: Task) => facts?.[t.id];
  const dirty = others.filter((t) => (f(t)?.uncommitted_count ?? 0) > 0);
  const branches = others.filter((t) => f(t)?.branch);
  const prs = others.filter((t) => t.pr_url);
  const pick = async () => {
    if (busy || !facts) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.pickFanout(picked.host_id, picked.id, { delete_branches: deleteBranches, close_prs: closePrs, discard_uncommitted: discard });
      onPicked();
      if (r.results.some((o) => o.notes.length)) setResults(r.results);
      else onClose();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const name = `${key(picked)} (${labelOf(picked)})`;
  if (results)
    return (
      <Modal title={`Picked ${name}`} onClose={onClose} width="max-w-lg">
        <div className="space-y-3 text-[13px]">
          {results.map((o) => (
            <div key={o.id} className="space-y-1">
              <div className="text-fg">
                <span className="font-mono text-[12px] text-faint">{o.key}</span> {outcomeText(o)}
              </div>
              {o.notes.map((n, i) => (
                <div key={i} className="flex gap-1.5 text-[12px] whitespace-pre-wrap text-amber-300">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {n}
                </div>
              ))}
            </div>
          ))}
          <ModalFooter className="flex justify-end">
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </ModalFooter>
        </div>
      </Modal>
    );
  return (
    <Modal title={`Pick ${name}?`} onClose={onClose} onSubmit={pick} width="max-w-lg">
      <div className="space-y-4 text-[13px]">
        <p className="text-muted">
          {key(picked)} stays as it is. {others.length === 1 ? "The other one is" : `The other ${others.length} are`} completed as{" "}
          <span className="text-fg">Not done</span>, and {others.length === 1 ? "its worktree is" : "their worktrees are"} removed:
        </p>
        {!facts && !loadErr && (
          <div className="flex items-center gap-2 text-faint">
            <Loader2 size={13} className="animate-spin" /> Checking their worktrees…
          </div>
        )}
        {loadErr && <div className="rounded bg-red-500/10 p-2 text-[12px] text-red-300">Couldn't check their worktrees: {loadErr}</div>}
        {facts && (
          <ul className="space-y-2">
            {others.map((t) => {
              const x = f(t);
              const notes: ReactNode[] = [];
              if (x?.working || t.running) notes.push(<span className="text-amber-300">Its agent is at work: it's stopped.</span>);
              if (t.status === "done") notes.push(`Done already (${statusLabel(t)}): it stays so, and is cleaned up.`);
              if (x && x.uncommitted_count > 0)
                notes.push(
                  <span className="text-amber-300" title={x.uncommitted.join("\n")}>
                    {plural(x.uncommitted_count, "uncommitted change")} in its worktree: {x.uncommitted.slice(0, 3).map((l) => l.slice(3)).join(", ")}
                    {x.uncommitted_count > 3 && "…"}
                  </span>,
                );
              if (x?.uncommitted_error) notes.push(<span className="text-amber-300">Its worktree couldn't be checked: {x.uncommitted_error}</span>);
              if (!t.worktree_path) notes.push("It has no worktree.");
              return (
                <li key={t.id} className="rounded-lg border border-line px-3 py-2">
                  <div className="flex items-center gap-2">
                    <StatusIcon status={t.status} size={13} />
                    <span className="font-mono text-[12px] text-faint">{key(t)}</span>
                    <span className="min-w-0 truncate text-fg">{labelOf(t)}</span>
                  </div>
                  {notes.length > 0 && (
                    <ul className="mt-1 space-y-0.5 text-[12px] text-muted">
                      {notes.map((n, i) => (
                        <li key={i}>{n}</li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {facts && (
          <div className="space-y-2.5">
            {dirty.length > 0 && (
              <Check checked={discard} onChange={setDiscard} danger label="Discard their uncommitted changes">
                {discard
                  ? `The uncommitted changes in ${dirty.map(key).join(", ")} are lost.`
                  : `Unticked, ${dirty.map(key).join(", ")} ${dirty.length === 1 ? "keeps its worktree" : "keep their worktrees"} with the changes in, to look at later.`}
              </Check>
            )}
            {branches.length > 0 && (
              <Check checked={deleteBranches} onChange={setDeleteBranches} danger label={branches.length === 1 ? "Delete its branch" : "Delete their branches"}>
                {branches.map((t) => f(t)!.branch).join(", ")}
                {branches.some((t) => f(t)!.pushed) && ", here and where they're pushed (unless a pull request kept open has them)"}. Commits on them that
                aren't merged anywhere are lost.
              </Check>
            )}
            {prs.length > 0 && (
              <Check checked={closePrs} onChange={setClosePrs} label={prs.length === 1 ? "Close its pull request" : "Close their pull requests"}>
                {prs.map((t) => `${key(t)}: ${t.pr_url}`).join(", ")}
              </Check>
            )}
          </div>
        )}
        {err && <div className="rounded bg-red-500/10 p-2 text-[12px] whitespace-pre-wrap text-red-300">{err}</div>}
        <ModalFooter className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !facts} onClick={pick}>
            {busy && <Loader2 size={13} className="animate-spin" />} Pick {key(picked)}
          </Button>
        </ModalFooter>
      </div>
    </Modal>
  );
}

function Check({ checked, onChange, label, danger, children }: { checked: boolean; onChange: (v: boolean) => void; label: string; danger?: boolean; children: ReactNode }) {
  return (
    <label className="flex cursor-pointer gap-2.5">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className={clsx("mt-0.5 shrink-0", danger ? "accent-red-500" : "accent-accent")} />
      <span>
        <span className="text-fg">{label}</span>
        <span className="block text-[12px] text-muted">{children}</span>
      </span>
    </label>
  );
}

/** What picking did with one of the others, in a line. */
function outcomeText(o: PickOutcome) {
  const parts = [o.completed ? "completed as Not done" : o.stopped ? "stopped" : "left as it was"];
  if (o.worktree !== "none") parts.push(`worktree ${o.worktree}`);
  if (o.branch !== "none") parts.push(`branch ${o.branch}`);
  if (o.pushed_branch !== "none") parts.push(`pushed branch ${o.pushed_branch}`);
  if (o.pr !== "none") parts.push(`pull request ${o.pr === "closed" ? "closed" : "kept open"}`);
  return parts.join(" · ");
}
