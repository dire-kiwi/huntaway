import clsx from "clsx";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import { addDays, PALETTE, SCRATCH, startOfDay, type ATask } from "../../analytics";
import { navigate } from "../../router";
import {
  allTokens,
  byDay,
  byImplementer,
  byReviewer,
  byTask,
  effortLabel,
  format,
  groupBy,
  issuesByModelAndEffort,
  METRIC_LABEL,
  ownerOf,
  PURPOSE_HINT,
  PURPOSE_LABEL,
  PURPOSES,
  purposeOf,
  reviewsByTask,
  summarise,
  ticks,
  tokens,
  topOf,
  total,
  usd,
  value,
  type IssueCell,
  type Metric,
  type Purpose,
  type ReviewSummary,
  type TaskUsage,
  type TokenData,
  type Totals,
  type URow,
} from "../../tokenStats";
import { Swatch, useTip } from "./chart";

/** The Analytics page's Tokens tab: where agents' tokens go, on which models, and what reviews find. */

/** Each purpose keeps its colour whatever is shown (validated for CVD separation on the dark panel). */
const COLOR: Record<Purpose, string> = Object.fromEntries(PURPOSES.map((p, i) => [p, PALETTE[i]])) as Record<Purpose, string>;
const pct = (n: number, of: number) => (of ? `${Math.round((n * 100) / of)}%` : "–");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "3 runs", "2 calls" (for titles and window restarts), or both. */
const uses = (t: Totals) => [t.runs || !t.calls ? plural(t.runs, "run") : "", t.calls ? plural(t.calls, "call") : ""].filter(Boolean).join(" and ");

function openTask(t: ATask | undefined) {
  if (t) navigate({ name: "task", taskId: t.id });
}

export function TokenStats({ data, project }: { data: TokenData; project: string }) {
  const [metric, setMetric] = useState<Metric>("tokens");
  const projectOf = (threadId: string) => data.tasks[topOf(data, ownerOf(data, threadId))]?.projectId ?? SCRATCH;
  // Window restarts are in no project.
  const keep = (threadId: string | null) => project === "all" || (threadId !== null && projectOf(threadId) === project);
  const rows = data.rows.filter((r) => keep(r.threadId));
  const scoped = { ...data, rows, reviews: data.reviews.filter((r) => keep(r.taskId)) };
  return (
    <>
      <div className="flex items-center gap-3">
        <span className="text-[12px] text-faint">Measure</span>
        <div className="flex items-center gap-1 rounded-lg border border-line bg-panel p-0.5">
          {(["tokens", "output", "cost"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMetric(m)}
              title={m === "cost" ? "What Claude Code said it cost. Codex doesn't say, so its runs count as nothing here." : undefined}
              className={clsx("rounded-md px-2 py-0.5 text-[12px]", metric === m ? "bg-raised text-fg" : "text-muted hover:text-fg")}
            >
              {METRIC_LABEL[m]}
            </button>
          ))}
        </div>
        {data.pending > 0 && <span className="text-[11.5px] text-faint">{plural(data.pending, "finished run is", "finished runs are")} still being counted</span>}
      </div>
      <Tiles rows={rows} />
      <DailyChart data={scoped} metric={metric} />
      <div className="grid gap-6 lg:grid-cols-2">
        <ByPurpose data={scoped} metric={metric} />
        <ByModel rows={rows} metric={metric} />
      </div>
      <Tasks data={scoped} metric={metric} />
      <Reviews data={scoped} />
    </>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-panel/60 px-4 py-3">
      <div className="text-[11.5px] text-faint">{label}</div>
      <div className="mt-1 text-[20px] leading-8 font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 text-[11.5px] text-faint">{hint}</div>
    </div>
  );
}

function Tiles({ rows }: { rows: URow[] }) {
  const t = rows.length ? total(rows) : null;
  const codex = rows.filter((r) => r.runtime === "codex");
  const codexTokens = codex.reduce((n, r) => n + allTokens(r), 0);
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Tile label="All tokens" value={tokens(t ? allTokens(t) : 0)} hint={t ? `${tokens(t.cacheRead)} of them cache reads` : "none counted"} />
      <Tile label="Output tokens" value={tokens(t?.output ?? 0)} hint={t ? `${tokens(t.input + t.cacheWrite)} input and cache writes` : "–"} />
      <Tile label="Cost" value={usd(t?.cost ?? 0)} hint={codex.length ? `Claude's; Codex used ${tokens(codexTokens)} tokens` : "as Claude Code reports it"} />
      <Tile
        label="Runs"
        value={String(t?.runs ?? 0)}
        hint={`on ${plural(new Set(rows.map((r) => r.model)).size, "model")}${t?.calls ? `, and ${plural(t.calls, "title or window call")}` : ""}`}
      />
    </div>
  );
}

function DailyChart({ data, metric }: { data: TokenData; metric: Metric }) {
  const { bind, node } = useTip();
  const days: number[] = [];
  for (let d = startOfDay(data.from); d < data.to; d = addDays(d, 1)) days.push(d);
  const perDay = byDay(data, data.rows, days);
  const totals = perDay.map((d) => PURPOSES.reduce((n, p) => n + value(d.parts[p], metric), 0));
  const max = Math.max(...totals, 0);
  const { top, ticks: lines } = ticks(max);
  const shown = PURPOSES.filter((p) => perDay.some((d) => value(d.parts[p], metric) > 0));
  const every = Math.ceil(days.length / 16);
  return (
    <section>
      <h2 className="mb-2 text-[13px] font-medium">{METRIC_LABEL[metric]} by day</h2>
      {max === 0 ? (
        <Empty>Nothing counted in this range</Empty>
      ) : (
        <div className="rounded-lg border border-line bg-panel/60 p-4">
          <div className="relative h-52 pl-12">
            {lines.map((v) => (
              <div key={v} className="absolute right-0 left-12 border-t border-white/[0.06]" style={{ bottom: `${(v * 100) / top}%` }}>
                <span className="absolute -top-2 -left-12 w-10 text-right text-[10.5px] text-faint tabular-nums">{metric === "cost" ? `$${v}` : tokens(v)}</span>
              </div>
            ))}
            <div className="relative flex h-full items-end gap-[2px]">
              {perDay.map((d, i) => {
                const segs = PURPOSES.map((p) => ({ p, v: value(d.parts[p], metric) })).filter((s) => s.v > 0);
                return (
                  <div
                    key={d.day}
                    className="flex h-full min-w-0 flex-1 cursor-default flex-col-reverse gap-[2px] rounded-sm hover:bg-white/[0.03]"
                    {...bind(() => (
                      <>
                        <div className="mb-1 font-medium">{new Date(d.day).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</div>
                        {segs.length === 0 && <div className="text-faint">Nothing</div>}
                        {segs.map(({ p, v }) => (
                          <div key={p} className="flex items-center gap-1.5">
                            <Swatch color={COLOR[p]} />
                            <span className="min-w-0 flex-1 truncate text-muted">{PURPOSE_LABEL[p]}</span>
                            <span className="pl-3 tabular-nums">{format(v, metric)}</span>
                          </div>
                        ))}
                        {segs.length > 1 && <div className="mt-1 border-t border-line pt-1 text-right tabular-nums">{format(totals[i], metric)}</div>}
                      </>
                    ))}
                  >
                    {segs.map(({ p, v }, j) => (
                      <div
                        key={p}
                        className={clsx("w-full shrink-0", j === segs.length - 1 && "rounded-t-[4px]")}
                        style={{ height: `calc(${(v * 100) / top}% - 2px)`, minHeight: 2, background: COLOR[p] }}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="mt-1 flex gap-[2px] pl-12">
            {days.map((d, i) => (
              <div key={d} className="min-w-0 flex-1 text-center text-[10.5px] text-faint tabular-nums">
                {i % every === 0 ? (days.length <= 7 ? new Date(d).toLocaleDateString(undefined, { weekday: "short", day: "numeric" }) : new Date(d).getDate()) : ""}
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-muted">
            {shown.map((p) => (
              <span key={p} className="flex items-center gap-1.5" title={PURPOSE_HINT[p]}>
                <Swatch color={COLOR[p]} />
                {PURPOSE_LABEL[p]}
              </span>
            ))}
          </div>
          {node}
        </div>
      )}
    </section>
  );
}

const th = "px-3 py-2 text-right font-normal";
const td = "px-3 py-1.5 text-right tabular-nums";

/** The columns every breakdown has: all tokens, output, cost and its share of the whole. */
function Cells({ t, metric, whole }: { t: Totals; metric: Metric; whole: number }) {
  return (
    <>
      <td className={td} title={`${tokens(t.input)} input · ${tokens(t.cacheRead)} cache reads · ${tokens(t.cacheWrite)} cache writes · ${tokens(t.output)} output`}>
        {tokens(allTokens(t))}
      </td>
      <td className={clsx(td, "text-muted")} title={t.reasoning ? `${tokens(t.reasoning)} of it thinking` : undefined}>
        {tokens(t.output)}
      </td>
      <td className={clsx(td, "text-muted")}>
        {t.cost ? usd(t.cost) : ""}
        {t.estimated && <span title="Some of it is estimated from what runs cost">*</span>}
      </td>
      <td className={clsx(td, "text-faint")}>{pct(value(t, metric), whole)}</td>
    </>
  );
}

function Head({ first, metric }: { first: string; metric: Metric }) {
  return (
    <thead className="bg-panel text-left text-[11.5px] text-faint">
      <tr>
        <th className="px-3 py-2 font-normal">{first}</th>
        <th className={clsx(th, "w-20")} title="Input, cache reads and writes, and output">
          Tokens
        </th>
        <th className={clsx(th, "w-20")}>Output</th>
        <th className={clsx(th, "w-20")}>Cost</th>
        <th className={clsx(th, "w-16")} title={`Share of ${METRIC_LABEL[metric].toLowerCase()}`}>
          Share
        </th>
      </tr>
    </thead>
  );
}

function ByPurpose({ data, metric }: { data: TokenData; metric: Metric }) {
  const groups = groupBy(data.rows, (r) => purposeOf(data, r), metric);
  const whole = groups.reduce((n, g) => n + value(g.totals, metric), 0);
  return (
    <section>
      <h2 className="mb-2 text-[13px] font-medium">What they were spent on</h2>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[34rem] table-fixed text-[12.5px]">
          <Head first="Spent on" metric={metric} />
          <tbody className="divide-y divide-line">
            {groups.map((g) => (
              <tr key={g.key} className="bg-panel/60">
                <td className="px-3 py-1.5" title={PURPOSE_HINT[g.key]}>
                  <span className="flex items-center gap-2">
                    <Swatch color={COLOR[g.key]} />
                    {PURPOSE_LABEL[g.key]}
                    <span className="text-faint">· {uses(g.totals)}</span>
                  </span>
                </td>
                <Cells t={g.totals} metric={metric} whole={whole} />
              </tr>
            ))}
            {!groups.length && (
              <tr className="bg-panel/60">
                <td colSpan={5} className="px-3 py-3 text-center text-faint">
                  Nothing counted
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ByModel({ rows, metric }: { rows: URow[]; metric: Metric }) {
  const groups = groupBy(rows, (r) => `${r.runtime}\u0000${r.model}`, metric);
  const whole = groups.reduce((n, g) => n + value(g.totals, metric), 0);
  return (
    <section>
      <h2 className="mb-2 text-[13px] font-medium">Models</h2>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[34rem] table-fixed text-[12.5px]">
          <Head first="Model" metric={metric} />
          <tbody className="divide-y divide-line">
            {groups.map((g) => {
              const [runtime, model] = g.key.split("\u0000");
              return (
                <tr key={g.key} className="bg-panel/60">
                  <td className="truncate px-3 py-1.5" title={`${model}, in ${uses(g.totals)}`}>
                    {model} <span className="text-faint">· {runtime === "codex" ? "Codex" : "Claude"}</span>
                  </td>
                  <Cells t={g.totals} metric={metric} whole={whole} />
                </tr>
              );
            })}
            {!groups.length && (
              <tr className="bg-panel/60">
                <td colSpan={5} className="px-3 py-3 text-center text-faint">
                  Nothing counted
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TaskLabel({ data, taskId }: { data: TokenData; taskId: string }) {
  const t = data.tasks[taskId];
  const p = data.projects[t?.projectId ?? SCRATCH] ?? data.projects[SCRATCH];
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Swatch color={p.color} />
      <span className="w-16 shrink-0 truncate font-mono text-[11.5px] text-faint">{t?.key}</span>
      <span className="min-w-0 truncate">{t?.title ?? "Deleted task"}</span>
    </span>
  );
}

const SPLIT: Purpose[] = ["task", "review", "summary", "compaction"];

function Tasks({ data, metric }: { data: TokenData; metric: Metric }) {
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const tasks = byTask(data, data.rows, metric);
  if (!tasks.length) return null;
  const list = all ? tasks : tasks.slice(0, 20);
  const part = (u: TaskUsage, p: Purpose) => {
    const t = p === "task" ? sumParts(u, ["task", "scratch", "group"]) : u.parts[p];
    return t && value(t, metric) ? format(value(t, metric), metric) : "";
  };
  const row = (u: TaskUsage, child: boolean) => {
    const isOpen = open.has(u.taskId);
    const toggle = () => setOpen((s) => new Set(isOpen ? [...s].filter((x) => x !== u.taskId) : [...s, u.taskId]));
    return (
      <tr key={u.taskId} className="cursor-pointer bg-panel/60 hover:bg-raised" onClick={() => openTask(data.tasks[u.taskId])}>
        <td className={clsx("py-1.5 pr-3", child ? "pl-9" : "pl-2")}>
          <span className="flex min-w-0 items-center gap-1">
            {!child &&
              (u.children.length ? (
                <button
                  className="shrink-0 rounded p-0.5 text-faint hover:text-fg"
                  title={isOpen ? "Hide its tasks" : `Show its ${plural(u.children.length, "task")}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle();
                  }}
                >
                  {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                </button>
              ) : (
                <span className="w-[21px] shrink-0" />
              ))}
            <TaskLabel data={data} taskId={u.taskId} />
          </span>
        </td>
        {SPLIT.map((p) => (
          <td key={p} className={clsx(td, "text-muted")}>
            {part(u, p)}
          </td>
        ))}
        <td className={clsx(td, "font-medium")} title={u.children.length ? "With its tasks'" : undefined}>
          {format(value(u.totals, metric), metric)}
        </td>
        <td className="truncate px-3 py-1.5 text-muted" title={u.models.map((m) => `${m.model}: ${format(value(m.totals, metric), metric)}`).join("\n")}>
          {u.models[0]?.model}
          {u.models.length > 1 && <span className="text-faint"> +{u.models.length - 1}</span>}
        </td>
      </tr>
    );
  };
  return (
    <section>
      <h2 className="mb-2 text-[13px] font-medium">
        Tasks <span className="font-normal text-faint">· {METRIC_LABEL[metric].toLowerCase()}, with their reviews, summaries and compactions</span>
      </h2>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[56rem] table-fixed text-[12.5px]">
          <thead className="bg-panel text-left text-[11.5px] text-faint">
            <tr>
              <th className="px-3 py-2 font-normal">Task</th>
              {SPLIT.map((p) => (
                <th key={p} className={clsx(th, "w-24")} title={PURPOSE_HINT[p]}>
                  {p === "task" ? "Its agent" : PURPOSE_LABEL[p]}
                </th>
              ))}
              <th className={clsx(th, "w-24")}>Total</th>
              <th className="w-36 px-3 py-2 font-normal">Model</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {list.map((u) => (
              <Fragment key={u.taskId}>
                {row(u, false)}
                {open.has(u.taskId) && u.children.map((c) => row(c, true))}
              </Fragment>
            ))}
          </tbody>
        </table>
        {!all && tasks.length > list.length && (
          <button className="w-full border-t border-line bg-panel/60 px-3 py-2 text-center text-[12px] text-muted hover:bg-raised hover:text-fg" onClick={() => setAll(true)}>
            Show all {tasks.length}
          </button>
        )}
      </div>
    </section>
  );
}

function sumParts(u: TaskUsage, ps: Purpose[]): Totals | undefined {
  const parts = ps.map((p) => u.parts[p]).filter((t) => t !== undefined);
  if (!parts.length) return undefined;
  return parts.reduce((a, b) => ({
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning,
    cost: a.cost + b.cost,
    runs: a.runs + b.runs,
    calls: a.calls + b.calls,
    estimated: a.estimated || b.estimated,
  }));
}

function Reviews({ data }: { data: TokenData }) {
  const tasks = reviewsByTask(data);
  const s = summarise(data.reviews, tasks);
  const implementers = byImplementer(data, tasks);
  const reviewers = byReviewer(data.reviews);
  return (
    <section className="space-y-3">
      <h2 className="text-[13px] font-medium">Reviews</h2>
      {!s.reviews ? (
        <Empty>No reviews in this range</Empty>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Tile label="Reviews" value={String(s.reviews)} hint={`of ${plural(s.tasks, "task")}, in ${plural(new Set(data.reviews.map((r) => `${r.taskId} ${r.round}`)).size, "round")}`} />
            <Tile label="Found serious issues" value={pct(s.withIssues, s.reviews)} hint={`${plural(s.serious, "issue")} in ${plural(s.withIssues, "review")}`} />
            <Tile label="Passed the first round" value={pct(s.firstPassed, s.tasks)} hint={`${s.firstPassed} of ${plural(s.tasks, "task")}`} />
            <Tile
              label="Noted minor issues"
              value={pct(s.minorNoted, s.reviews)}
              hint={
                <span title="Follow-up tasks the reviewed task's agent created after a review that noted minor issues">
                  {s.minorTasksFollowedUp} of {plural(s.minorTasks, "task")} got {plural(s.followUps, "follow-up")}
                </span>
              }
            />
          </div>
          <SeriousIssues data={data} />
          <div className="grid gap-6 lg:grid-cols-2">
            <ReviewTable
              title="By the model that did the work"
              first="Model"
              hint="The model each reviewed task's own agent used most"
              rows={implementers.map((m) => ({ key: m.model, s: m.summary }))}
              implementer
            />
            <ReviewTable title="By reviewer" first="Reviewer" rows={reviewers.map((r) => ({ key: r.reviewer, s: r.summary }))} />
          </div>
        </>
      )}
    </section>
  );
}

/** Serious issues found in each model's work, at each effort it worked at and across all of them. */
function SeriousIssues({ data }: { data: TokenData }) {
  const { efforts, models, total } = issuesByModelAndEffort(data, data.reviews);
  const cell = (c: IssueCell | undefined, who: string) => {
    if (!c) return <span className="text-faint">–</span>;
    const title = `${who}: ${plural(c.serious, "serious issue")} in ${plural(c.reviews, "review")} of ${plural(c.tasks, "task")}, ${c.withIssues} of the reviews found some`;
    return (
      <span title={title}>
        {c.serious} <span className="text-faint">· {(c.serious / c.tasks).toFixed(1)}/task</span>
      </span>
    );
  };
  return (
    <div>
      <h3 className="mb-2 text-[12.5px] text-muted" title="Serious issues the reviews found, by the model each reviewed task's agent used and the effort it was set to work at. Per task: serious issues divided by the tasks reviewed.">
        Serious issues by model and effort
      </h3>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[34rem] text-[12.5px]">
          <thead className="bg-panel text-left text-[11.5px] text-faint">
            <tr>
              <th className="px-3 py-2 font-normal">Model</th>
              <th className={th}>All efforts</th>
              {efforts.map((e) => (
                <th key={e} className={th} title={e === "default" ? "The agent's own default effort, or one the host doesn't say" : undefined}>
                  {effortLabel(e)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {[...models, total].map((m) => (
              <tr key={m.model} className={clsx(m === total ? "bg-raised/40 font-medium" : "bg-panel/60")}>
                <td className="truncate px-3 py-1.5" title={m.model}>
                  {m.model}
                </td>
                <td className={td}>{cell(m.all, `${m.model}, all efforts`)}</td>
                {efforts.map((e) => (
                  <td key={e} className={td}>
                    {cell(m.byEffort[e], `${m.model}, ${effortLabel(e)} effort`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ReviewTable({ title, first, hint, rows, implementer }: { title: string; first: string; hint?: string; rows: { key: string; s: ReviewSummary }[]; implementer?: boolean }) {
  return (
    <div>
      <h3 className="mb-2 text-[12.5px] text-muted" title={hint}>
        {title}
      </h3>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[34rem] table-fixed text-[12.5px]">
          <thead className="bg-panel text-left text-[11.5px] text-faint">
            <tr>
              <th className="px-3 py-2 font-normal">{first}</th>
              {implementer ? (
                <>
                  <th className={clsx(th, "w-16")}>Tasks</th>
                  <th className={clsx(th, "w-24")} title="Tasks whose first round of review found no serious issues, if it was before this range too">
                    First pass
                  </th>
                  <th className={clsx(th, "w-28")} title="Rounds of review that found serious issues, per task: all of its rounds, if some were outside this range">
                    Rounds of fixes
                  </th>
                </>
              ) : (
                <>
                  <th className={clsx(th, "w-16")}>Reviews</th>
                  <th className={clsx(th, "w-24")} title="Reviews that found serious issues">
                    Found issues
                  </th>
                  <th className={clsx(th, "w-28")} title="Minor issues listed, by the reviews that list them">
                    Minor listed
                  </th>
                </>
              )}
              <th className={clsx(th, "w-20")}>Serious</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map(({ key, s }) => (
              <tr key={key} className="bg-panel/60">
                <td className="truncate px-3 py-1.5" title={key}>
                  {key}
                </td>
                {implementer ? (
                  <>
                    <td className={td}>{s.tasks}</td>
                    <td className={td}>
                      {pct(s.firstPassed, s.tasks)} <span className="text-faint">· {s.firstPassed}</span>
                    </td>
                    <td className={clsx(td, "text-muted")}>{s.tasks ? (s.roundsWithIssues / s.tasks).toFixed(1) : "–"}</td>
                  </>
                ) : (
                  <>
                    <td className={td}>{s.reviews}</td>
                    <td className={td}>
                      {pct(s.withIssues, s.reviews)} <span className="text-faint">· {s.withIssues}</span>
                    </td>
                    <td className={clsx(td, "text-muted")} title={`${s.minorNoted} reviews noted minor issues`}>
                      {s.minorListed ? `${s.minor} in ${s.minorListed}` : "–"}
                    </td>
                  </>
                )}
                <td className={clsx(td, "text-muted")}>{s.serious}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Empty({ children }: { children: string }) {
  return <div className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-[12.5px] text-faint">{children}</div>;
}
