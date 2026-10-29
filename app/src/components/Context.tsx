import clsx from "clsx";
import { useEffect, useState } from "react";
import { api, type ContextCategory, type ContextDetail, type ContextSummary, type Task } from "../api";
import { Modal, timeAgo } from "./ui";

/** "830", "84.2k", "1M". */
export function tokens(n: number) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${+(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${+(n / 1_000_000).toFixed(1)}M`;
}

function percent(n: number, of: number) {
  const p = (n / of) * 100;
  return p > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`;
}

/** Categorical colours, one per kind of content, in the order the bar draws them. Unknown ones are grey. */
const COLORS: Record<string, string> = {
  messages: "#3987e5",
  system_prompt: "#d95926",
  system_tools: "#199e70",
  mcp_tools: "#c98500",
  mcp_instructions: "#d55181",
  custom_agents: "#008300",
  memory_files: "#9085e9",
  skills: "#e66767",
};
const ORDER = Object.keys(COLORS);
const OTHER = "#8b8b9c";
const FREE = "rgba(255,255,255,0.07)";
const BUFFER = "repeating-linear-gradient(135deg, rgba(255,255,255,0.16) 0 2px, rgba(255,255,255,0.04) 2px 6px)";

type Segment = { id: string; name: string; tokens: number; fill: string; note?: string };

function kind(c: ContextCategory) {
  return c.kind ?? (c.isDeferred ? "deferred" : c.id === "free_space" ? "free" : c.id.endsWith("compact_buffer") ? "buffer" : "used");
}

/** Bar segments (used, then free, then the compact buffer), and what's listed but not loaded. */
function segments(ctx: ContextSummary, detail: ContextDetail | null): { max: number | null; used: number; bar: Segment[]; deferred: ContextCategory[] } {
  if (detail) {
    const cats = detail.categories;
    const used = cats
      .filter((c) => kind(c) === "used")
      .sort((a, b) => (ORDER.indexOf(a.id) + 1 || 99) - (ORDER.indexOf(b.id) + 1 || 99))
      .map((c) => ({ id: c.id, name: c.name, tokens: c.tokens, fill: COLORS[c.id] ?? OTHER }));
    const rest = cats
      .filter((c) => kind(c) === "free" || kind(c) === "buffer")
      .sort((a, b) => Number(kind(a) !== "free") - Number(kind(b) !== "free"))
      .map((c) => ({
        id: c.id,
        name: c.name,
        tokens: c.tokens,
        fill: kind(c) === "free" ? FREE : BUFFER,
        note: kind(c) === "buffer" ? "Kept free: the session compacts when it fills up to here" : undefined,
      }));
    return { max: detail.maxTokens, used: detail.totalTokens, bar: [...used, ...rest], deferred: cats.filter((c) => kind(c) === "deferred") };
  }
  const bar: Segment[] = [{ id: "used", name: "Used", tokens: ctx.tokens, fill: COLORS.messages }];
  if (ctx.max_tokens) {
    const buffer = ctx.compact_at ? Math.max(0, ctx.max_tokens - ctx.compact_at) : 0;
    bar.push({ id: "free_space", name: "Free space", tokens: Math.max(0, ctx.max_tokens - ctx.tokens - buffer), fill: FREE });
    if (buffer)
      bar.push({
        id: "autocompact_buffer",
        name: "Autocompact buffer",
        tokens: buffer,
        fill: BUFFER,
        note: "Kept free: the session compacts when it fills up to here",
      });
  }
  return { max: ctx.max_tokens, used: ctx.tokens, bar, deferred: [] };
}

/** Whether the agent is close to compacting (or to the end of its window). */
function nearlyFull(ctx: ContextSummary) {
  const limit = ctx.compact_at ?? ctx.max_tokens;
  return !!limit && ctx.tokens >= limit * 0.85;
}

function summaryTitle(ctx: ContextSummary) {
  const lines = [
    ctx.max_tokens
      ? `Context: ${tokens(ctx.tokens)} of ${tokens(ctx.max_tokens)} tokens (${percent(ctx.tokens, ctx.max_tokens)})`
      : `Context: ${tokens(ctx.tokens)} tokens`,
  ];
  if (ctx.compact_at) lines.push(`Compacts at ${tokens(ctx.compact_at)}`);
  lines.push(`Updated ${timeAgo(ctx.updated_at)}`);
  return lines.join("\n");
}

/** How full the agent's context window is; opens the breakdown, like Claude Code's `/context`. */
export function ContextPill({ task, className }: { task: Task; className?: string }) {
  const [open, setOpen] = useState(false);
  const ctx = task.context;
  if (!ctx) return null;
  const fill = ctx.max_tokens ? Math.min(100, (ctx.tokens / ctx.max_tokens) * 100) : null;
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={summaryTitle(ctx)}
        className={clsx("flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-line px-2 text-[12px] text-muted hover:bg-white/5", className)}
      >
        Context
        {fill != null && (
          <span className="h-1 w-8 overflow-hidden rounded-full bg-white/[0.07]">
            <span className={clsx("block h-full rounded-full", nearlyFull(ctx) ? "bg-st-attention" : "bg-accent")} style={{ width: `${fill}%` }} />
          </span>
        )}
        <span className={clsx("tabular-nums", nearlyFull(ctx) ? "text-st-attention" : "text-faint")}>
          {ctx.max_tokens ? percent(ctx.tokens, ctx.max_tokens) : tokens(ctx.tokens)}
        </span>
      </button>
      {open && <ContextDialog task={task} ctx={ctx} onClose={() => setOpen(false)} />}
    </>
  );
}

function ContextDialog({ task, ctx, onClose }: { task: Task; ctx: ContextSummary; onClose: () => void }) {
  const [detail, setDetail] = useState<ContextDetail | null>();
  const [err, setErr] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  // Again whenever the agent sends a new breakdown.
  useEffect(() => {
    api
      .context(task.host_id, task.id)
      .then((r) => setDetail(r.detail))
      .catch((e) => setErr(e.message));
  }, [task.host_id, task.id, ctx.detail_at]);

  const { max, used, bar, deferred } = segments(ctx, detail ?? null);
  const hovered = bar.find((s) => s.id === hover);
  const stale = detail && ctx.detail_at && ctx.updated_at > ctx.detail_at && ctx.tokens !== detail.totalTokens;
  const model = detail?.model ?? ctx.model;

  return (
    <Modal title="Context usage" onClose={onClose} width="max-w-xl">
      <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1 text-[12.5px]">
        <div>
          <div className="flex items-baseline gap-2">
            <span className="text-[20px] font-semibold tabular-nums">{max ? percent(used, max) : tokens(used)}</span>
            <span className="text-muted tabular-nums">{max ? `${tokens(used)} of ${tokens(max)} tokens` : "tokens"}</span>
            {model && <span className="ml-auto truncate font-mono text-[11px] text-faint">{model}</span>}
          </div>
          {max ? (
            <>
              <div className="mt-2 flex h-3 gap-[2px] overflow-hidden rounded" onMouseLeave={() => setHover(null)}>
                {bar
                  .filter((s) => s.tokens > 0)
                  .map((s) => (
                    <div
                      key={s.id}
                      onMouseEnter={() => setHover(s.id)}
                      className={clsx("h-full transition-opacity", hover && hover !== s.id && "opacity-40")}
                      style={{ width: `${(s.tokens / max) * 100}%`, minWidth: 3, background: s.fill }}
                    />
                  ))}
              </div>
              <div className="mt-1 h-4 text-[11.5px] text-muted tabular-nums">
                {hovered && (
                  <>
                    <span className="text-fg">{hovered.name}</span> · {tokens(hovered.tokens)} tokens · {percent(hovered.tokens, max)}
                  </>
                )}
              </div>
            </>
          ) : null}
          {stale && (
            <div className="text-[11.5px] text-faint">
              The breakdown is from the end of the agent's last turn ({timeAgo(ctx.detail_at!)}). It has {tokens(ctx.tokens)} tokens in context now.
            </div>
          )}
          {detail === null && (
            <div className="text-[11.5px] text-faint">
              No breakdown yet. Claude Code agents send one at the end of each turn; Codex agents only report the total.
            </div>
          )}
          {err && <div className="text-[11.5px] text-red-300">{err}</div>}
        </div>

        <table className="w-full tabular-nums">
          <tbody>
            {bar.map((s) => (
              <tr
                key={s.id}
                onMouseEnter={() => setHover(s.id)}
                onMouseLeave={() => setHover(null)}
                className={clsx(hover === s.id && "bg-white/5")}
                title={s.note}
              >
                <td className="w-4 py-0.5 pl-1">
                  <span
                    className="block h-2.5 w-2.5 rounded-sm"
                    style={{ background: s.fill, outline: s.fill === FREE ? "1px solid rgba(255,255,255,0.15)" : undefined }}
                  />
                </td>
                <td className="py-0.5 text-fg">{s.name}</td>
                <td className="py-0.5 text-right text-muted">{tokens(s.tokens)}</td>
                <td className="w-12 py-0.5 pr-1 pl-3 text-right text-faint">{max ? percent(s.tokens, max) : ""}</td>
              </tr>
            ))}
            {deferred.map((c) => (
              <tr key={c.id} title="Listed by name only; loaded when the agent uses them">
                <td />
                <td className="py-0.5 text-faint">{c.name}</td>
                <td className="py-0.5 text-right text-faint">{tokens(c.tokens)}</td>
                <td className="py-0.5 pr-1 pl-3 text-right whitespace-nowrap text-faint">not loaded</td>
              </tr>
            ))}
          </tbody>
        </table>
        {detail && <div className="text-[11px] text-faint">The total is from the agent's last reply; its parts are Claude Code's estimates.</div>}

        {detail && <DetailLists detail={detail} />}
      </div>
    </Modal>
  );
}

function List({ title, rows, limit = 8 }: { title: string; rows: { name: string; tokens: number; sub?: string }[]; limit?: number }) {
  const [all, setAll] = useState(false);
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => b.tokens - a.tokens);
  const shown = all ? sorted : sorted.slice(0, limit);
  return (
    <div>
      <div className="mb-1 text-[11px] font-semibold tracking-wide text-faint uppercase">{title}</div>
      {shown.map((r, i) => (
        <div key={i} className="flex items-baseline gap-2 py-0.5 pl-1">
          <span className="min-w-0 truncate text-fg" title={r.name}>
            {r.name}
          </span>
          {r.sub && <span className="shrink-0 truncate text-[11px] text-faint">{r.sub}</span>}
          <span className="ml-auto shrink-0 pr-1 text-muted tabular-nums">{tokens(r.tokens)}</span>
        </div>
      ))}
      {sorted.length > limit && (
        <button className="pl-1 text-[11.5px] text-faint hover:text-muted" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `${sorted.length - limit} more`}
        </button>
      )}
    </div>
  );
}

/** The messages by kind. What's left of the Messages category is the system reminders and attachments
 *  Claude Code adds (counted separately, with things outside the messages too, so not used as is). */
function messageRows(detail: ContextDetail, m: NonNullable<ContextDetail["messageBreakdown"]>) {
  const rows = [
    { name: "Tool calls", tokens: m.toolCallTokens },
    { name: "Tool results", tokens: m.toolResultTokens },
    { name: "Agent's replies", tokens: m.assistantMessageTokens },
    { name: "Prompts", tokens: m.userMessageTokens },
  ];
  const total = detail.categories.find((c) => c.id === "messages")?.tokens ?? 0;
  const rest = total - rows.reduce((n, r) => n + r.tokens, 0);
  if (rest > 0) rows.push({ name: "Reminders and attachments", tokens: rest });
  return rows.filter((r) => r.tokens > 0);
}

/** What's behind the categories: messages by type, MCP servers, memory files, agents and skills. */
function DetailLists({ detail }: { detail: ContextDetail }) {
  const m = detail.messageBreakdown;
  const servers = new Map<string, { tokens: number; tools: number; loaded: number }>();
  for (const t of detail.mcpTools ?? []) {
    const s = servers.get(t.serverName) ?? { tokens: 0, tools: 0, loaded: 0 };
    s.tokens += t.tokens;
    s.tools += 1;
    if (t.isLoaded !== false) s.loaded += 1;
    servers.set(t.serverName, s);
  }
  return (
    <div className="space-y-4">
      {m && <List title="Messages" limit={5} rows={messageRows(detail, m)} />}
      {m?.toolCallsByType && (
        <List
          title="Tool use by tool"
          rows={m.toolCallsByType.map((t) => ({
            name: t.name,
            tokens: t.callTokens + t.resultTokens,
            sub: `${tokens(t.callTokens)} calls · ${tokens(t.resultTokens)} results`,
          }))}
        />
      )}
      <List
        title="MCP servers"
        rows={[...servers].map(([name, s]) => ({
          name,
          tokens: s.tokens,
          sub: s.loaded < s.tools ? `${s.loaded} of ${s.tools} tools loaded` : `${s.tools} tools`,
        }))}
      />
      <List title="Memory files" rows={(detail.memoryFiles ?? []).map((f) => ({ name: f.path, tokens: f.tokens, sub: f.type }))} />
      <List title="Custom agents" rows={(detail.agents ?? []).map((a) => ({ name: a.agentType, tokens: a.tokens, sub: a.source }))} />
      <List title="Skills" rows={(detail.skills?.skillFrontmatter ?? []).map((s) => ({ name: s.name, tokens: s.tokens, sub: s.source }))} />
    </div>
  );
}
