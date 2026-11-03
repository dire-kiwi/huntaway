import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { memo, useEffect, useMemo, useState } from "react";
import { useRevealed, useThreadConfig, useThreadState } from "../hooks.js";
import { ShieldIcon, SpinnerIcon, XIcon } from "../icons.js";
import { toolMeta } from "../toolMeta.js";
import { Subagent } from "./Subagent.js";
import { Chevron, CodeBlock, cx, Markdown } from "./ui.js";
const inputOf = (call) => (call.input && typeof call.input === "object" ? call.input : {});
const str = (x) => (typeof x === "string" ? x : "");
/** How the call's drawn: the app's renderer for its name, over the app's for its kind, over the built-in one. */
export function toolRenderer(config, call) {
    const byName = config.tools?.[call.name];
    const byKind = config.toolKinds?.[call.kind];
    const builtin = (call.name === "ExitPlanMode" ? planRenderer : undefined) ?? builtinToolRenderers[call.kind] ?? builtinToolRenderers.other;
    return byName || byKind ? { ...builtin, ...byKind, ...byName } : builtin;
}
/**
 * What a permission card shows of the call it asks about, under its summary line: the renderer's
 * body, except the built-in ones that only show a result (read, search, web), whose input it shows
 * instead (what's to be read, searched or fetched).
 */
export function permissionBody(renderer) {
    return renderer.Body === ReadBody || renderer.Body === WebBody ? InputBody : (renderer.Body ?? GenericBody);
}
/** A tool call: its summary line, which opens to show its input and result. */
export const ToolCall = memo(function ToolCall({ call, className }) {
    const config = useThreadConfig();
    const renderer = toolRenderer(config, call);
    const request = useThreadState((s) => s.view.requestsByCall.get(call.id));
    if (renderer.Row)
        return (_jsx("div", { className: cx("at-tool", className), "data-tool-row": "", children: _jsx(renderer.Row, { call: call, request: request }) }));
    if (call.kind === "subagent" && !config.tools?.[call.name]?.Body && !config.toolKinds?.subagent?.Body)
        return _jsx(Subagent, { call: call, className: className });
    return _jsx(PlainToolCall, { call: call, renderer: renderer, request: request, className: className });
});
function PlainToolCall({ call, renderer, request, className }) {
    const [open, setOpen] = useState(false);
    const cwd = useThreadState((s) => s.snapshot.thread.cwd);
    const meta = { ...toolMeta(call, cwd), ...renderer.meta?.(call, cwd) };
    const Body = renderer.Body ?? GenericBody;
    return (_jsxs("div", { className: cx("at-tool", `at-tool-${call.kind}`, `at-tool-${call.status}`, className), "data-tool-row": "", children: [_jsxs("button", { type: "button", className: "at-tool-head", "aria-expanded": open, onClick: () => setOpen(!open), children: [_jsx(Chevron, { open: open }), _jsx("span", { className: "at-tool-icon", children: meta.icon }), _jsx("span", { className: "at-tool-label", children: meta.label }), _jsx("span", { className: "at-tool-summary", children: meta.summary }), _jsx(ToolStatus, { call: call, request: request })] }), open && (_jsx("div", { className: "at-tool-body", children: _jsx(Body, { call: call }) }))] }));
}
/** Where a call's got to, at the end of its row: nothing once it's done. */
export function ToolStatus({ call, request }) {
    if (request)
        return (_jsxs("span", { className: "at-tool-status at-attention", children: [request.type === "question" ? "waiting for an answer" : "needs approval", " ", _jsx(ShieldIcon, { size: 12 })] }));
    switch (call.status) {
        case "pending":
        case "running":
            return (_jsx("span", { className: "at-tool-status at-progress", "aria-label": call.status, children: _jsx(SpinnerIcon, { size: 12, className: "at-spin" }) }));
        case "failed":
            return (_jsx("span", { className: "at-tool-status at-bad", "aria-label": "failed", children: _jsx(XIcon, { size: 12 }) }));
        case "denied":
            return _jsx("span", { className: "at-tool-status at-bad", children: "denied" });
        case "cancelled":
            return _jsx("span", { className: "at-tool-status at-faint", children: "cancelled" });
        default:
            return null;
    }
}
// ---------- groups ----------
/** How many of a group's calls show before "Show n earlier". */
const SHOWN = 6;
/** Tool calls in a row: the latest few, and a button for the rest. */
export const ToolGroup = memo(function ToolGroup({ group, className }) {
    const [expanded, setExpanded] = useState(false);
    const hidden = group.calls.length - SHOWN;
    // A subagent being revealed that's in one of the hidden calls shows them.
    const hiddenIds = useMemo(() => (hidden > 0 ? group.calls.slice(0, hidden).map((c) => c.id) : []), [group.calls, hidden]);
    const reveal = useRevealed(hiddenIds);
    useEffect(() => {
        if (reveal)
            setExpanded(true);
    }, [reveal]);
    const shown = expanded || hidden <= 0 ? group.calls : group.calls.slice(hidden);
    return (_jsxs("div", { className: cx("at-tool-group", className), children: [!expanded && hidden > 0 && (_jsxs("button", { type: "button", className: "at-tool-more", onClick: () => setExpanded(true), children: ["Show ", hidden, " earlier tool call", hidden > 1 ? "s" : ""] })), shown.map((c) => (_jsx(ToolCall, { call: c }, c.id)))] }));
});
// ---------- built-in bodies ----------
/** The call's result: its text (an error's in red), and whether it was cut short. */
export function ToolResultView({ call }) {
    const r = call.result;
    if (!r)
        return null;
    const error = call.status === "failed" || (r.exit_code != null && r.exit_code !== 0);
    const text = r.content || (r.structured != null ? JSON.stringify(r.structured, null, 2) : "");
    return (_jsxs(_Fragment, { children: [_jsx(CodeBlock, { text: text, tone: error ? "error" : undefined }), (r.truncated || (r.exit_code != null && r.exit_code !== 0)) && (_jsx("div", { className: "at-tool-note", children: [r.exit_code != null && r.exit_code !== 0 && `exit code ${r.exit_code}`, r.truncated && "output cut short"].filter(Boolean).join(" · ") }))] }));
}
function InputBody({ call }) {
    return _jsx(CodeBlock, { text: JSON.stringify(call.input, null, 2) ?? "" });
}
function GenericBody({ call }) {
    return (_jsxs(_Fragment, { children: [_jsx(CodeBlock, { text: JSON.stringify(call.input, null, 2) ?? "" }), _jsx(ToolResultView, { call: call })] }));
}
function ShellBody({ call }) {
    const command = call.command ?? str(inputOf(call).command);
    return (_jsxs(_Fragment, { children: [_jsx(CodeBlock, { text: `$ ${command}`, className: "at-code-command" }), _jsx(ToolResultView, { call: call })] }));
}
function ReadBody({ call }) {
    return call.result ? _jsx(ToolResultView, { call: call }) : _jsx("div", { className: "at-tool-note", children: "Reading\u2026" });
}
function WebBody({ call }) {
    const url = call.url ?? str(inputOf(call).url);
    return (_jsxs(_Fragment, { children: [url && /^https?:\/\//.test(url) && (_jsx("a", { className: "at-tool-link", href: url, target: "_blank", rel: "noreferrer", children: url })), _jsx(ToolResultView, { call: call })] }));
}
/** A file edit: each change's diff, or the edit as the harness gave it. Its result only if it failed. */
function EditBody({ call }) {
    const input = inputOf(call);
    const changes = call.changes ?? [];
    let shown;
    if (changes.some((c) => c.diff))
        shown = changes.map((c, i) => _jsx(PatchDiff, { change: c }, i));
    else if (typeof input.old_string === "string" || typeof input.new_string === "string")
        shown = _jsx(EditDiff, { before: str(input.old_string), after: str(input.new_string) });
    else if (Array.isArray(input.edits))
        shown = input.edits.map((e, i) => _jsx(EditDiff, { before: str(e.old_string), after: str(e.new_string) }, i));
    else if (typeof input.content === "string")
        shown = _jsx(CodeBlock, { text: input.content });
    else
        shown = _jsx(CodeBlock, { text: JSON.stringify(call.input, null, 2) ?? "" });
    return (_jsxs(_Fragment, { children: [shown, call.status === "failed" && _jsx(ToolResultView, { call: call })] }));
}
/** A replacement of `before` with `after`, as Claude's Edit gives it. */
export function EditDiff({ before, after }) {
    return (_jsxs("pre", { className: "at-code at-diff", children: [before.split("\n").map((l, i) => (_jsxs("div", { className: "at-diff-del", children: ["- ", l] }, `o${i}`))), after.split("\n").map((l, i) => (_jsxs("div", { className: "at-diff-add", children: ["+ ", l] }, `n${i}`)))] }));
}
/** A unified diff of one file, as Codex gives it. */
export function PatchDiff({ change }) {
    const lines = (change.diff ?? "").replace(/\n$/, "").split("\n");
    const tone = (l) => l.startsWith("+") && !l.startsWith("+++") ? "at-diff-add" : l.startsWith("-") && !l.startsWith("---") ? "at-diff-del" : l.startsWith("@@") ? "at-diff-hunk" : undefined;
    return (_jsxs("div", { className: "at-diff-file", children: [_jsxs("div", { className: "at-diff-path", children: [change.op === "add" ? "new " : change.op === "delete" ? "deleted " : "", change.path, change.move_to ? ` → ${change.move_to}` : ""] }), _jsx("pre", { className: "at-code at-diff", children: lines.map((l, i) => (_jsx("div", { className: tone(l), children: l || " " }, i))) })] }));
}
function TodoBody({ call }) {
    const todos = call.todos ?? [];
    if (!todos.length)
        return _jsx(GenericBody, { call: call });
    return (_jsx("ul", { className: "at-todos", children: todos.map((t, i) => (_jsxs("li", { className: `at-todo at-todo-${t.status}`, children: [_jsx("span", { "aria-hidden": true, children: t.status === "completed" ? "✓" : t.status === "in_progress" ? "◐" : "○" }), " ", t.text] }, i))) }));
}
/** Claude's ExitPlanMode: the plan, and what the agent was told (approved, or the user's feedback). */
function PlanBody({ call }) {
    const plan = str(inputOf(call).plan);
    if (!plan)
        return _jsx(GenericBody, { call: call });
    return (_jsxs(_Fragment, { children: [_jsx(Markdown, { text: plan, className: "at-plan" }), call.status === "denied" && _jsx(ToolResultView, { call: call })] }));
}
const planRenderer = { Body: PlanBody };
/** The built-in renderers, by kind. */
export const builtinToolRenderers = {
    shell: { Body: ShellBody },
    read: { Body: ReadBody },
    edit: { Body: EditBody },
    search: { Body: ReadBody },
    web: { Body: WebBody },
    mcp: { Body: GenericBody },
    app: { Body: GenericBody },
    subagent: { Body: GenericBody },
    todo: { Body: TodoBody },
    other: { Body: GenericBody },
};
