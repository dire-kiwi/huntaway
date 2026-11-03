import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useLoadEarlier, useRevealed, useThreadState } from "../hooks.js";
import { isLoaded } from "../store.js";
import { BotIcon, CheckIcon, FileIcon, ShieldIcon, SpinnerIcon, XIcon } from "../icons.js";
import { toolMeta } from "../toolMeta.js";
import { NO_ITEMS } from "../view.js";
import { MessageList } from "./MessageList.js";
import { LoadEarlier } from "./LoadEarlier.js";
import { Chevron, CodeBlock, Collapsible, cx, Markdown, plural } from "./ui.js";
const inputOf = (call) => (call.input && typeof call.input === "object" ? call.input : {});
const str = (x) => (typeof x === "string" ? x : "");
/** What kind of subagent it is, e.g. "Explore"; "Skill" for a skill's forked one, "Subagent" for a general one. */
export function subagentKind(call) {
    const type = call.subagent?.agent_type || str(inputOf(call).subagent_type);
    if (type && type !== "general-purpose")
        return type;
    return call.name === "Skill" ? "Skill" : "Subagent";
}
/** Its title: its description, or the first line of its prompt. */
export function subagentTitle(call) {
    const input = inputOf(call);
    return call.title || str(input.description) || str(input.prompt).split("\n")[0].slice(0, 80) || subagentKind(call);
}
/**
 * The subagent's report, from its call's result: Claude frames a subagent's report with notes for
 * the agent (its lines indented under "The report follows:"), which this takes off.
 */
export function reportText(content) {
    const marker = "The report follows:\n";
    const at = content.indexOf(marker);
    if (at < 0)
        return content.trim();
    const lines = [];
    for (const line of content.slice(at + marker.length).split("\n")) {
        if (line && !line.startsWith("  "))
            break;
        lines.push(line.slice(2));
    }
    return lines.join("\n").trim();
}
/** What it's doing now: its latest tool call, or writing its reply (or its latest progress report, if it has no items). */
function activity(call, items, cwd) {
    const last = items[items.length - 1];
    if (!last)
        return call.subagent?.activity;
    if (last.type === "tool_call") {
        const m = toolMeta(last, cwd);
        return m.summary ? `${m.label} ${m.summary}` : m.label;
    }
    if (last.type === "assistant_message")
        return "Writing…";
    if (last.type === "reasoning")
        return "Thinking…";
    return undefined;
}
/** Where a subagent's got to: working (and on what), waiting on the user, done, failed or stopped. */
export function SubagentStatusBadge({ status, waiting, activity, className }) {
    return (_jsx("span", { className: cx("at-tool-status", className), children: status === "running" && waiting ? (_jsxs("span", { className: "at-attention", children: ["needs you ", _jsx(ShieldIcon, { size: 12 })] })) : status === "running" ? (_jsxs(_Fragment, { children: [activity && _jsx("span", { className: "at-subagent-activity", children: activity }), _jsx(SpinnerIcon, { size: 12, className: "at-spin at-progress" })] })) : status === "completed" ? (_jsx(CheckIcon, { size: 12, className: "at-good" })) : status === "failed" ? (_jsxs("span", { className: "at-bad", children: ["failed ", _jsx(XIcon, { size: 12 })] })) : (_jsx("span", { className: "at-faint", children: "stopped" })) }));
}
/** A subagent's row, which opens to show what it did. */
export const Subagent = memo(function Subagent({ call, className }) {
    const sub = useThreadState((s) => s.view.subagents.get(call.id));
    const cwd = useThreadState((s) => s.snapshot.thread.cwd);
    const [open, setOpen] = useState(false);
    const [flash, setFlash] = useState(false);
    const ref = useRef(null);
    const ids = useMemo(() => [call.id], [call.id]);
    const reveal = useRevealed(ids);
    useEffect(() => {
        if (!reveal)
            return;
        setOpen(true);
        if (!reveal.self)
            return;
        setFlash(true);
        reveal.done();
        requestAnimationFrame(() => ref.current?.scrollIntoView?.({ block: "start", behavior: "smooth" }));
    }, [reveal]);
    useEffect(() => {
        if (!flash)
            return;
        const t = setTimeout(() => setFlash(false), 1500);
        return () => clearTimeout(t);
    }, [flash]);
    // One that started before the items loaded has them loaded back to its start once it's opened.
    // They come in below its row, and the thread keeps its place from the end: it's shown again after.
    const loaded = useThreadState((s) => isLoaded(s.snapshot, call.id));
    const loadEarlier = useLoadEarlier();
    useEffect(() => {
        if (open && !loaded)
            void loadEarlier({ to: call.id }).then(() => ref.current?.scrollIntoView?.({ block: "start" }));
    }, [open, loaded, loadEarlier, call.id]);
    const items = sub?.items ?? NO_ITEMS;
    const status = sub?.status ?? "running";
    return (_jsxs("div", { ref: ref, className: cx("at-tool", "at-subagent", flash && "at-flash", className), "data-tool-row": "", "data-subagent": call.id, children: [_jsxs("button", { type: "button", className: "at-tool-head", "aria-expanded": open, onClick: () => setOpen(!open), children: [_jsx(Chevron, { open: open }), _jsx("span", { className: "at-tool-icon", children: _jsx(BotIcon, {}) }), _jsx("span", { className: "at-tool-label", children: subagentKind(call) }), _jsx("span", { className: "at-tool-summary at-subagent-title", children: subagentTitle(call) }), sub?.background && (_jsx("span", { className: "at-subagent-tag", title: "It runs in the background, after its call has returned", children: "background" })), _jsx(SubagentStatusBadge, { status: status, waiting: sub?.waiting, activity: status === "running" ? activity(call, items, cwd) : undefined })] }), open && sub && _jsx(SubagentBody, { sub: sub, loaded: loaded })] }));
});
/**
 * What a subagent did, under its row: its prompt, its items and its report. A background
 * subagent's report is its summary (its call's result only says it started).
 */
function SubagentBody({ sub, loaded }) {
    const { call } = sub;
    const input = inputOf(call);
    const meta = [call.subagent?.model || str(input.model), sub.background && "in the background", sub.toolUses > 0 && plural(sub.toolUses, "tool use")].filter(Boolean);
    const prompt = str(input.prompt);
    const hasText = sub.items.some((i) => i.type === "assistant_message" && i.text.trim());
    const report = sub.background ? (call.subagent?.summary ?? "") : call.result && call.status === "completed" ? reportText(call.result.content) : "";
    const error = sub.background ? report : (call.result?.content ?? "");
    return (_jsxs("div", { className: "at-subagent-body", children: [meta.length > 0 && _jsx("div", { className: "at-subagent-meta", children: meta.join(" · ") }), prompt && (_jsx(Collapsible, { label: "Prompt", icon: _jsx(FileIcon, {}), children: _jsx("div", { className: "at-pre-wrap", children: prompt }) })), !loaded && _jsx(LoadEarlier, { to: sub.id }), _jsx(MessageList, { parentId: sub.id }), sub.status === "running" && (_jsxs("div", { className: "at-working", children: [_jsx("span", { className: "at-dot" }), " ", sub.background ? "Working in the background…" : "Working…"] })), sub.status === "failed" && error ? (_jsx(CodeBlock, { text: error, tone: "error" })) : (!hasText && report && _jsx(Markdown, { text: report })), sub.status === "stopped" && !report && _jsx("div", { className: "at-faint at-small", children: "Stopped before it finished." })] }));
}
