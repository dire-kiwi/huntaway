import clsx from "clsx";
import { BookOpen, Bot, ChevronRight, FileText, Globe, LayoutGrid, ListChecks, Loader2, Pencil, Search, Terminal, Wrench, X } from "lucide-react";
import { memo, useContext, useEffect, useState, type ReactNode } from "react";
import { publishedDocPath } from "../../../docs";
import { navigate } from "../../../router";
import type { Call } from "../../../threadModel";
import { lineage, ThreadCtx, usePendingFocus, useThread } from "./context";
import { SubagentRow } from "./subagents";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export function toolMeta(name: string, input: Any, cwd?: string | null): { icon: ReactNode; label: string; summary: string } {
  const rel = (p?: string) => (p && cwd && p.startsWith(cwd + "/") ? p.slice(cwd.length + 1) : (p ?? ""));
  const s = 13;
  switch (name) {
    case "Bash":
      return { icon: <Terminal size={s} />, label: "Ran", summary: input?.command ?? "" };
    case "Read":
      return { icon: <FileText size={s} />, label: "Read", summary: rel(input?.file_path) };
    case "Edit":
    case "MultiEdit":
      return { icon: <Pencil size={s} />, label: "Edited", summary: rel(input?.file_path) };
    case "Write":
      return { icon: <Pencil size={s} />, label: "Wrote", summary: rel(input?.file_path) };
    // Codex's file edits (see agent/codex.rs on the server).
    case "ApplyPatch": {
      const changes: Any[] = input?.changes ?? [];
      const label = changes.length && changes.every((c) => c.kind === "add") ? "Wrote" : changes.every((c) => c.kind === "delete") ? "Deleted" : "Edited";
      return { icon: <Pencil size={s} />, label, summary: changes.map((c) => rel(c.path)).join(", ") };
    }
    case "NotebookEdit":
      return { icon: <Pencil size={s} />, label: "Edited", summary: rel(input?.notebook_path) };
    case "Grep":
      return { icon: <Search size={s} />, label: "Searched", summary: `${input?.pattern ?? ""}${input?.path ? `  in ${rel(input.path)}` : ""}` };
    case "Glob":
      return { icon: <Search size={s} />, label: "Listed", summary: input?.pattern ?? "" };
    case "WebFetch":
      return { icon: <Globe size={s} />, label: "Fetched", summary: input?.url ?? "" };
    case "WebSearch":
      return { icon: <Globe size={s} />, label: "Searched web", summary: input?.query ?? "" };
    case "Task":
    case "Agent":
      return { icon: <Bot size={s} />, label: "Subagent", summary: input?.description ?? "" };
    case "TodoWrite":
      return { icon: <ListChecks size={s} />, label: "Updated todos", summary: `${input?.todos?.length ?? 0} items` };
  }
  // The board's own server; mcp__issue_agent__ is its name before the rename to Huntaway.
  const board = /^mcp__(huntaway|issue_agent)__/;
  if (board.test(name)) {
    const tool = name.replace(board, "");
    return {
      icon: <LayoutGrid size={s} />,
      label: "Board",
      summary: `${tool}${input?.title ? `  “${input.title}”` : input?.question ? `  ${input.question}` : ""}`,
    };
  }
  // The run's docs server (HA-280).
  if (name.startsWith("mcp__docs__")) {
    const what = input?.title ?? input?.slug;
    return { icon: <BookOpen size={s} />, label: "Docs", summary: `${name.slice("mcp__docs__".length)}${what ? `  “${what}”` : ""}` };
  }
  return { icon: <Wrench size={s} />, label: name.replace(/^mcp__/, "").replace(/__/g, " · "), summary: "" };
}

/** A link to the document a `publish_document` call published, on this board's Docs page (HA-281). */
function PublishedDoc({ call }: { call: Call }) {
  if (call.name !== "mcp__docs__publish_document" || !call.result || call.result.isError) return null;
  const doc = publishedDocPath(call.result.content);
  if (!doc) return null;
  return (
    <a
      href={doc.path}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(doc.path);
      }}
      className="ml-7 flex w-fit items-center gap-1.5 rounded px-2 py-0.5 text-[12.5px] text-accent hover:bg-white/[0.03] hover:underline"
    >
      <BookOpen size={12} />
      Open “{call.input?.title ?? doc.slug}”{doc.version !== null ? ` (v${doc.version})` : ""} in Docs
    </a>
  );
}

function EditDiff({ oldStr, newStr }: { oldStr: string; newStr: string }) {
  return (
    <pre className="overflow-x-auto rounded-md border border-line bg-[#0c0c10] p-2 font-mono text-[12px] leading-[1.45]">
      {oldStr.split("\n").map((l, i) => (
        <div key={`o${i}`} className="bg-red-500/10 text-red-300">
          - {l}
        </div>
      ))}
      {newStr.split("\n").map((l, i) => (
        <div key={`n${i}`} className="bg-emerald-500/10 text-emerald-300">
          + {l}
        </div>
      ))}
    </pre>
  );
}

/** A unified diff, as Codex reports a file change. */
function PatchDiff({ change }: { change: Any }) {
  const tone = (l: string) =>
    l.startsWith("+") && !l.startsWith("+++")
      ? "bg-emerald-500/10 text-emerald-300"
      : l.startsWith("-") && !l.startsWith("---")
        ? "bg-red-500/10 text-red-300"
        : l.startsWith("@@")
          ? "text-faint"
          : "text-[#c9c9d6]";
  const lines = String(change.diff ?? "")
    .replace(/\n$/, "")
    .split("\n");
  return (
    <div>
      <div className="mb-1 font-mono text-[11.5px] text-muted">
        {change.kind === "add" ? "new " : change.kind === "delete" ? "deleted " : ""}
        {change.path}
        {change.move_path ? ` → ${change.move_path}` : ""}
      </div>
      <pre className="max-h-80 overflow-auto rounded-md border border-line bg-[#0c0c10] p-2 font-mono text-[12px] leading-[1.45]">
        {lines.map((l, i) => (
          <div key={i} className={tone(l)}>
            {l || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}

export function ToolInput({ name, input }: { name: string; input: Any }) {
  if (name === "Bash") return <CodeBlock text={input?.command ?? ""} />;
  if (name === "ApplyPatch")
    return (
      <div className="space-y-2">
        {(input?.changes ?? []).map((c: Any, i: number) => (
          <PatchDiff key={i} change={c} />
        ))}
      </div>
    );
  if (name === "Edit") return <EditDiff oldStr={input?.old_string ?? ""} newStr={input?.new_string ?? ""} />;
  if (name === "MultiEdit")
    return (
      <div className="space-y-1">
        {(input?.edits ?? []).map((e: Any, i: number) => (
          <EditDiff key={i} oldStr={e.old_string ?? ""} newStr={e.new_string ?? ""} />
        ))}
      </div>
    );
  if (name === "Write") return <CodeBlock text={input?.content ?? ""} max="max-h-64" />;
  if (name === "TodoWrite")
    return (
      <ul className="space-y-0.5 text-[12.5px]">
        {(input?.todos ?? []).map((t: Any, i: number) => (
          <li key={i} className={clsx("flex gap-2", t.status === "completed" && "text-faint line-through")}>
            <span>{t.status === "completed" ? "✓" : t.status === "in_progress" ? "◐" : "○"}</span>
            {t.content}
          </li>
        ))}
      </ul>
    );
  return <CodeBlock text={JSON.stringify(input, null, 2)} />;
}

export function CodeBlock({ text, max = "max-h-80", tone }: { text: string; max?: string; tone?: "error" }) {
  return (
    <pre
      className={clsx(
        "overflow-auto rounded-md border border-line bg-[#0c0c10] p-2 font-mono text-[12px] leading-[1.45] whitespace-pre-wrap break-words",
        max,
        tone === "error" ? "text-red-300" : "text-[#c9c9d6]",
      )}
    >
      {text || <span className="text-faint">(empty)</span>}
    </pre>
  );
}

/** Tools whose input already shows the change, so only an error result is worth showing. */
const EDIT_TOOLS = ["Edit", "Write", "ApplyPatch"];

const ToolRow = memo(function ToolRow({ call, running, cwd }: { call: Call; running: boolean; cwd?: string | null }) {
  const sub = useThread((t) => t.subagents.get(call.id));
  if (sub) return <SubagentRow call={call} sub={sub} />;
  return <PlainToolRow call={call} running={running} cwd={cwd} />;
});

function PlainToolRow({ call, running, cwd }: { call: Call; running: boolean; cwd?: string | null }) {
  const [open, setOpen] = useState(false);
  const m = toolMeta(call.name, call.input, cwd);
  const pending = !call.result;
  return (
    <div data-tool-row>
      <button onClick={() => setOpen(!open)} className="group flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12.5px] hover:bg-white/[0.03]">
        <ChevronRight size={12} className={clsx("shrink-0 text-faint transition-transform", open && "rotate-90")} />
        <span className="shrink-0 text-muted">{m.icon}</span>
        <span className="shrink-0 text-muted">{m.label}</span>
        <span className="min-w-0 truncate font-mono text-[12px] text-[#b9b9c8]">{m.summary}</span>
        <span className="ml-auto shrink-0">
          {pending && running ? (
            <Loader2 size={12} className="animate-spin text-st-progress" />
          ) : call.result?.isError ? (
            <X size={12} className="text-red-400" />
          ) : null}
        </span>
      </button>
      <PublishedDoc call={call} />
      {open && (
        <div className="space-y-2 px-2 pb-2 pl-7">
          <ToolInput name={call.name} input={call.input} />
          {call.result && !EDIT_TOOLS.includes(call.name) && <CodeBlock text={call.result.content} tone={call.result.isError ? "error" : undefined} />}
          {call.result?.isError && EDIT_TOOLS.includes(call.name) && <CodeBlock text={call.result.content} tone="error" />}
        </div>
      )}
    </div>
  );
}

export const ToolGroup = memo(function ToolGroup({ calls, running, cwd }: { calls: Call[]; running: boolean; cwd?: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const LIMIT = 6;
  const hidden = calls.length - LIMIT;
  const source = useContext(ThreadCtx)!;
  const focus = usePendingFocus();
  useEffect(() => {
    if (!focus || hidden <= 0) return;
    const path = lineage(source.data.subagents, focus.id);
    if (calls.slice(0, hidden).some((c) => path.includes(c.id))) setExpanded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);
  const shown = expanded || hidden <= 0 ? calls : calls.slice(-LIMIT);
  return (
    <div className="rounded-lg border border-line bg-panel/60 py-1">
      {!expanded && hidden > 0 && (
        <button onClick={() => setExpanded(true)} className="px-3 py-1 text-[12px] text-faint hover:text-muted">
          Show {hidden} earlier tool call{hidden > 1 ? "s" : ""}
        </button>
      )}
      {shown.map((c) => (
        <ToolRow key={c.id} call={c} running={running} cwd={cwd} />
      ))}
    </div>
  );
});
