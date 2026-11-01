/**
 * Statistics on how big threads' contexts get and when they're compacted (see server
 * context.rs), to tell whether compacting at some size would be worth it: each turn's end says
 * how big a context the next prompt starts from, and each compaction how big it had got.
 */

export type CompactSource = "auto" | "user" | "idle";

export interface CTurn {
  at: number;
  taskId: string;
  /** The context the turn left. */
  tokens: number;
  maxTokens: number | null;
  /** What the turn cost, when the agent reports it. */
  cost: number | null;
}

export interface CCompaction {
  at: number;
  taskId: string;
  source: CompactSource;
  /** The context before it, if known. */
  tokens: number | null;
  /** After it, if the agent says. */
  postTokens: number | null;
  durationMs: number | null;
}

export const SOURCE_LABEL: Record<CompactSource, string> = {
  idle: "Idle",
  user: "/compact",
  auto: "Agent's own",
};

export const SOURCE_HINT: Record<CompactSource, string> = {
  idle: "The board compacted the session after it sat idle",
  user: "Someone sent /compact",
  auto: "The agent compacted by itself as its context filled up",
};

/** Upper edges of the histogram's buckets; the last one is open. */
export const BUCKET_EDGES = [25_000, 50_000, 100_000, 150_000, 200_000, 300_000, 500_000, 750_000];

/** Sizes to ask "what if threads were compacted past this?" about. */
export const LIMITS = [50_000, 100_000, 150_000, 200_000, 300_000, 500_000];

/** e.g. "950", "12k", "1.2M". */
export function tokens(n: number) {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0).replace(/\.0$/, "")}M`;
}

/** The value at fraction `p` (0–1) of the sorted values, by nearest rank; null without any. */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
}

export interface Bucket {
  /** Inclusive lower edge. */
  from: number;
  /** Exclusive upper edge; null for the last. */
  to: number | null;
  turns: number;
  cost: number;
}

export function histogram(turns: CTurn[]): Bucket[] {
  const edges = [0, ...BUCKET_EDGES];
  const out: Bucket[] = edges.map((from, i) => ({ from, to: edges[i + 1] ?? null, turns: 0, cost: 0 }));
  for (const t of turns) {
    let i = edges.length - 1;
    while (i > 0 && t.tokens < edges[i]) i--;
    out[i].turns++;
    out[i].cost += t.cost ?? 0;
  }
  return out;
}

export interface LimitRow {
  limit: number;
  /** Turns that ended past the limit: those a compaction at it would have followed. */
  turns: number;
  /** Their share of the turns. */
  share: number;
  /** What the turns that started past the limit cost: the ones a compaction would have made cheaper. */
  cost: number;
  costShare: number;
  /** Tasks with a turn that ended past it. */
  tasks: number;
  /** Compactions that happened past it anyway (not counting the agent's own, which come at its threshold). */
  compactions: number;
}

/**
 * For each limit, how often threads went past it, and what the turns that then started past it
 * cost. A turn starts from the context the task's previous turn left.
 */
export function limitRows(turns: CTurn[], compactions: CCompaction[], limits = LIMITS): LimitRow[] {
  // A turn starts from what the task's previous turn left, or what a compaction since left.
  const timeline: { at: number; taskId: string; turn: CTurn | null; after: number }[] = [
    ...turns.map((t) => ({ at: t.at, taskId: t.taskId, turn: t, after: t.tokens })),
    ...compactions.map((c) => ({ at: c.at, taskId: c.taskId, turn: null, after: c.postTokens ?? 0 })),
  ];
  timeline.sort((a, b) => a.at - b.at);
  const startedAt = new Map<CTurn, number>();
  const prev = new Map<string, number>();
  for (const e of timeline) {
    if (e.turn) startedAt.set(e.turn, prev.get(e.taskId) ?? 0);
    prev.set(e.taskId, e.after);
  }
  const total = turns.length;
  const totalCost = turns.reduce((s, t) => s + (t.cost ?? 0), 0);
  return limits.map((limit) => {
    const past = turns.filter((t) => t.tokens > limit);
    const cost = turns.filter((t) => (startedAt.get(t) ?? 0) > limit).reduce((s, t) => s + (t.cost ?? 0), 0);
    return {
      limit,
      turns: past.length,
      share: total ? past.length / total : 0,
      cost,
      costShare: totalCost ? cost / totalCost : 0,
      tasks: new Set(past.map((t) => t.taskId)).size,
      compactions: compactions.filter((c) => c.source !== "auto" && (c.tokens ?? 0) > limit).length,
    };
  });
}

export interface TaskContext {
  taskId: string;
  turns: number;
  /** The biggest context a turn left, or a compaction found. */
  peak: number;
  last: number | null;
  compactions: number;
  cost: number;
}

/** Per task, biggest first. */
export function byTask(turns: CTurn[], compactions: CCompaction[]): TaskContext[] {
  const m = new Map<string, TaskContext>();
  const get = (id: string) => {
    let t = m.get(id);
    if (!t) m.set(id, (t = { taskId: id, turns: 0, peak: 0, last: null, compactions: 0, cost: 0 }));
    return t;
  };
  for (const t of [...turns].sort((a, b) => a.at - b.at)) {
    const r = get(t.taskId);
    r.turns++;
    r.peak = Math.max(r.peak, t.tokens);
    r.last = t.tokens;
    r.cost += t.cost ?? 0;
  }
  for (const c of compactions) {
    const r = get(c.taskId);
    r.compactions++;
    r.peak = Math.max(r.peak, c.tokens ?? 0);
  }
  return [...m.values()].sort((a, b) => b.peak - a.peak);
}
