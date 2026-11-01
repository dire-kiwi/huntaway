import clsx from "clsx";
import { useState } from "react";
import { PALETTE, SCRATCH, type ATask, type ContextData } from "../analytics";
import {
  byTask,
  histogram,
  limitRows,
  percentile,
  SOURCE_HINT,
  SOURCE_LABEL,
  tokens,
  type CCompaction,
  type CompactSource,
  type CTurn,
} from "../contextStats";
import { navigate } from "../router";
import { Swatch, useTip } from "./chart";

/** The Analytics page's Context tab: how big threads' contexts get, and when they're compacted. */

const BAR = PALETTE[0];
const usd = (n: number) => (n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`);
const pct = (n: number) => `${Math.round(n * 100)}%`;
const when = (t: number) => new Date(t).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const SOURCES: CompactSource[] = ["idle", "user", "auto"];

function openTask(t: ATask | undefined) {
  if (t) navigate({ name: "task", taskId: t.id });
}

export function ContextStats({ data, project }: { data: ContextData; project: string }) {
  const keep = (id: string) => project === "all" || (data.tasks[id]?.projectId ?? SCRATCH) === project;
  const turns = data.turns.filter((t) => keep(t.taskId));
  const compactions = data.compactions.filter((c) => keep(c.taskId));
  return (
    <>
      <Tiles turns={turns} compactions={compactions} />
      <Histogram turns={turns} />
      <Limits turns={turns} compactions={compactions} />
      <Compactions data={data} compactions={compactions} />
      <Tasks data={data} turns={turns} compactions={compactions} />
    </>
  );
}

function Tiles({ turns, compactions }: { turns: CTurn[]; compactions: CCompaction[] }) {
  const sizes = turns.map((t) => t.tokens);
  const value = (n: number | null) => (n === null ? "–" : tokens(n));
  const bySource = SOURCES.map((s) => `${compactions.filter((c) => c.source === s).length} ${SOURCE_LABEL[s].toLowerCase()}`).join(" · ");
  const tile = (label: string, v: string, hint: string) => (
    <div className="rounded-lg border border-line bg-panel/60 px-4 py-3">
      <div className="text-[11.5px] text-faint">{label}</div>
      <div className="mt-1 text-[20px] leading-8 font-semibold tabular-nums">{v}</div>
      <div className="mt-0.5 text-[11.5px] text-faint">{hint}</div>
    </div>
  );
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {tile("Median context", value(percentile(sizes, 0.5)), `at the end of ${turns.length} turn${turns.length === 1 ? "" : "s"}`)}
      {tile("90th percentile", value(percentile(sizes, 0.9)), `99th: ${value(percentile(sizes, 0.99))}`)}
      {tile("Largest", value(sizes.length ? Math.max(...sizes) : null), "at a turn's end")}
      {tile("Compactions", String(compactions.length), bySource)}
    </div>
  );
}

function Histogram({ turns }: { turns: CTurn[] }) {
  const { bind, node } = useTip();
  const buckets = histogram(turns);
  const top = Math.max(1, ...buckets.map((b) => b.turns));
  const label = (b: (typeof buckets)[number]) => (b.to === null ? `${tokens(b.from)}+` : `${tokens(b.from)}–${tokens(b.to)}`);
  return (
    <section>
      <h2 className="mb-2 text-[13px] font-medium">Context at the end of each turn</h2>
      {turns.length === 0 ? (
        <Empty>No turns recorded in this range</Empty>
      ) : (
        <div className="rounded-lg border border-line bg-panel/60 p-4">
          <div className="flex h-44 items-end gap-[2px]">
            {buckets.map((b) => (
              <div
                key={b.from}
                className="group flex h-full min-w-0 flex-1 cursor-default flex-col justify-end rounded-sm hover:bg-white/[0.03]"
                {...bind(() => (
                  <>
                    <div className="font-medium">{label(b)} tokens</div>
                    <div className="mt-0.5 text-muted tabular-nums">
                      {b.turns} turn{b.turns === 1 ? "" : "s"} · {pct(b.turns / turns.length)}
                    </div>
                    {b.cost > 0 && <div className="text-muted tabular-nums">{usd(b.cost)} spent on them</div>}
                  </>
                ))}
              >
                {b.turns > 0 && <div className="mb-1 text-center text-[10.5px] text-muted tabular-nums">{b.turns}</div>}
                <div className="rounded-t-[4px]" style={{ height: `${(b.turns * 100) / top}%`, background: BAR, minHeight: b.turns ? 2 : 0 }} />
              </div>
            ))}
          </div>
          <div className="mt-1 flex gap-[2px] border-t border-line pt-1">
            {buckets.map((b) => (
              <div key={b.from} className="min-w-0 flex-1 truncate text-center text-[10.5px] text-faint tabular-nums">
                {label(b)}
              </div>
            ))}
          </div>
          {node}
        </div>
      )}
    </section>
  );
}

function Limits({ turns, compactions }: { turns: CTurn[]; compactions: CCompaction[] }) {
  if (!turns.length) return null;
  const rows = limitRows(turns, compactions);
  const costs = turns.some((t) => t.cost !== null);
  return (
    <section>
      <h2 className="mb-2 text-[13px] font-medium">If threads were compacted past…</h2>
      <div className="overflow-hidden rounded-lg border border-line">
        <table className="w-full text-[12.5px]">
          <thead className="bg-panel text-left text-[11.5px] text-faint">
            <tr>
              <th className="px-3 py-2 font-normal">Context</th>
              <th className="px-3 py-2 text-right font-normal" title="Turns that left a bigger context: a compaction at this size would have followed each">
                Turns past it
              </th>
              <th className="px-3 py-2 text-right font-normal" title="Tasks with a turn that left a bigger context">
                Tasks
              </th>
              {costs && (
                <th className="px-3 py-2 text-right font-normal" title="What the turns that started from a bigger context cost: the ones a compaction would have made cheaper">
                  Cost of turns started past it
                </th>
              )}
              <th className="px-3 py-2 text-right font-normal" title="Idle and /compact compactions of a bigger context">
                Compacted past it
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={r.limit} className="bg-panel/60">
                <td className="px-3 py-1.5 tabular-nums">{tokens(r.limit)} tokens</td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {r.turns} <span className="text-faint">· {pct(r.share)}</span>
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.tasks}</td>
                {costs && (
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {usd(r.cost)} <span className="text-faint">· {pct(r.costShare)}</span>
                  </td>
                )}
                <td className="px-3 py-1.5 text-right tabular-nums">{r.compactions}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TaskLabel({ data, taskId }: { data: ContextData; taskId: string }) {
  const t = data.tasks[taskId];
  const p = data.projects[t?.projectId ?? SCRATCH] ?? data.projects[SCRATCH];
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Swatch color={p.color} />
      <span className="w-20 shrink-0 truncate font-mono text-[11.5px] text-faint">{t?.kind === "scratch" ? "chat" : t?.key}</span>
      <span className="min-w-0 truncate">{t?.title ?? "Deleted task"}</span>
    </span>
  );
}

function Compactions({ data, compactions }: { data: ContextData; compactions: CCompaction[] }) {
  const [source, setSource] = useState<CompactSource | "all">("all");
  const [all, setAll] = useState(false);
  const shown = compactions.filter((c) => source === "all" || c.source === source).reverse();
  const list = all ? shown : shown.slice(0, 20);
  return (
    <section>
      <div className="mb-2 flex items-center gap-3">
        <h2 className="text-[13px] font-medium">
          Compactions <span className="font-normal text-faint">· {shown.length}</span>
        </h2>
        <div className="flex items-center gap-1 rounded-lg border border-line bg-panel p-0.5">
          {(["all", ...SOURCES] as const).map((s) => (
            <button
              key={s}
              title={s === "all" ? undefined : SOURCE_HINT[s]}
              onClick={() => setSource(s)}
              className={clsx("rounded-md px-2 py-0.5 text-[12px]", source === s ? "bg-raised text-fg" : "text-muted hover:text-fg")}
            >
              {s === "all" ? "All" : SOURCE_LABEL[s]}
            </button>
          ))}
        </div>
      </div>
      {shown.length === 0 ? (
        <Empty>No compactions in this range</Empty>
      ) : (
        <div className="overflow-hidden rounded-lg border border-line">
          <table className="w-full table-fixed text-[12.5px]">
            <thead className="bg-panel text-left text-[11.5px] text-faint">
              <tr>
                <th className="w-36 px-3 py-2 font-normal">When</th>
                <th className="px-3 py-2 font-normal">Task</th>
                <th className="w-28 px-3 py-2 font-normal">Source</th>
                <th className="w-36 px-3 py-2 text-right font-normal">Before → after</th>
                <th className="w-20 px-3 py-2 text-right font-normal">Took</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {list.map((c, i) => (
                <tr key={`${c.at}-${i}`} className="cursor-pointer bg-panel/60 hover:bg-raised" onClick={() => openTask(data.tasks[c.taskId])}>
                  <td className="px-3 py-1.5 text-faint tabular-nums">{when(c.at)}</td>
                  <td className="px-3 py-1.5">
                    <TaskLabel data={data} taskId={c.taskId} />
                  </td>
                  <td className="px-3 py-1.5 text-muted" title={SOURCE_HINT[c.source]}>
                    {SOURCE_LABEL[c.source]}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {c.tokens === null ? "–" : tokens(c.tokens)} <span className="text-faint">→ {c.postTokens === null ? "–" : tokens(c.postTokens)}</span>
                  </td>
                  <td className="px-3 py-1.5 text-right text-muted tabular-nums">{c.durationMs === null ? "" : `${Math.round(c.durationMs / 1000)}s`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!all && shown.length > list.length && (
            <button className="w-full border-t border-line bg-panel/60 px-3 py-2 text-center text-[12px] text-muted hover:bg-raised hover:text-fg" onClick={() => setAll(true)}>
              Show all {shown.length}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function Tasks({ data, turns, compactions }: { data: ContextData; turns: CTurn[]; compactions: CCompaction[] }) {
  const [all, setAll] = useState(false);
  const rows = byTask(turns, compactions);
  if (!rows.length) return null;
  const list = all ? rows : rows.slice(0, 15);
  const costs = turns.some((t) => t.cost !== null);
  return (
    <section>
      <h2 className="mb-2 text-[13px] font-medium">Largest contexts by task</h2>
      <div className="overflow-hidden rounded-lg border border-line">
        <table className="w-full table-fixed text-[12.5px]">
          <thead className="bg-panel text-left text-[11.5px] text-faint">
            <tr>
              <th className="px-3 py-2 font-normal">Task</th>
              <th className="w-24 px-3 py-2 text-right font-normal" title="The biggest context a turn left, or a compaction found">
                Peak
              </th>
              <th className="w-24 px-3 py-2 text-right font-normal">Last turn</th>
              <th className="w-20 px-3 py-2 text-right font-normal">Turns</th>
              <th className="w-28 px-3 py-2 text-right font-normal">Compactions</th>
              {costs && <th className="w-24 px-3 py-2 text-right font-normal">Cost</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {list.map((r) => (
              <tr key={r.taskId} className="cursor-pointer bg-panel/60 hover:bg-raised" onClick={() => openTask(data.tasks[r.taskId])}>
                <td className="px-3 py-1.5">
                  <TaskLabel data={data} taskId={r.taskId} />
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">{tokens(r.peak)}</td>
                <td className="px-3 py-1.5 text-right text-muted tabular-nums">{r.last === null ? "" : tokens(r.last)}</td>
                <td className="px-3 py-1.5 text-right text-muted tabular-nums">{r.turns || ""}</td>
                <td className="px-3 py-1.5 text-right text-muted tabular-nums">{r.compactions || ""}</td>
                {costs && <td className="px-3 py-1.5 text-right text-muted tabular-nums">{r.cost ? usd(r.cost) : ""}</td>}
              </tr>
            ))}
          </tbody>
        </table>
        {!all && rows.length > list.length && (
          <button className="w-full border-t border-line bg-panel/60 px-3 py-2 text-center text-[12px] text-muted hover:bg-raised hover:text-fg" onClick={() => setAll(true)}>
            Show all {rows.length}
          </button>
        )}
      </div>
    </section>
  );
}

function Empty({ children }: { children: string }) {
  return <div className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-[12.5px] text-faint">{children}</div>;
}
