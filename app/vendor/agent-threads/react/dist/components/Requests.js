import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { memo, useEffect, useRef, useState } from "react";
import { useRespond, useReveal, useThreadConfig, useThreadState } from "../hooks.js";
import { BotIcon, CheckIcon, MapIcon, QuestionIcon, SendIcon, ShieldIcon, XIcon } from "../icons.js";
import { subagentTitle } from "./Subagent.js";
import { planTitle, toolMeta } from "../toolMeta.js";
import { permissionBody, toolRenderer } from "./ToolCall.js";
import { Button, cx, Markdown } from "./ui.js";
const NO_REQUESTS = [];
/** The thread's open requests, oldest first: all of them, or those from one subagent (`parentId`, "" for the main thread's own). */
export const OpenRequests = memo(function OpenRequests({ parentId, className }) {
    const requests = useThreadState((s) => s.snapshot.requests ?? NO_REQUESTS);
    const shown = requests.filter((r) => !r.resolution && (parentId === undefined || (r.parent_id ?? "") === parentId));
    if (!shown.length)
        return null;
    return (_jsx("div", { className: cx("at-requests", className), children: shown.map((r) => r.type === "permission" ? _jsx(PermissionCard, { request: r }, r.id) : r.type === "plan" ? _jsx(PlanCard, { request: r }, r.id) : _jsx(QuestionCard, { request: r }, r.id)) }));
});
/** A request's card: a permission's, questions' or plan's, open or answered. */
export function RequestCard({ request, className }) {
    return request.type === "permission" ? (_jsx(PermissionCard, { request: request, className: className })) : request.type === "plan" ? (_jsx(PlanCard, { request: request, className: className })) : (_jsx(QuestionCard, { request: request, className: className }));
}
/** How a resolved request was answered, as a badge (a plan's: approved, or sent back). */
function Outcome({ resolution, plan }) {
    const [text, tone] = plan && resolution.outcome === "allow"
        ? ["Approved", "good"]
        : plan && resolution.outcome === "deny"
            ? ["Kept planning", "plain"]
            : resolution.outcome === "allow"
                ? [resolution.always ? "Always allowed" : "Allowed", "good"]
                : resolution.outcome === "deny"
                    ? [resolution.always ? "Always denied" : "Denied", "bad"]
                    : resolution.outcome === "answer"
                        ? ["Answered", "good"]
                        : ["Not answered", "plain"];
    return _jsx("span", { className: cx("at-outcome", `at-outcome-${tone}`), children: text });
}
/** Who's asking: "Claude", "Codex", or the harness's own name. */
const asker = (harness) => (harness === "claude" ? "Claude" : harness === "codex" ? "Codex" : harness);
/** The thread's item `id`, if it's a tool call. */
function findCall(s, id) {
    const items = s.snapshot.items;
    for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        if (item.id === id)
            return item.type === "tool_call" ? item : undefined;
    }
    return undefined;
}
/** For a request from a subagent: which one (it reveals the subagent's row). */
function From({ parentId }) {
    const sub = useThreadState((s) => (parentId ? s.view.subagents.get(parentId) : undefined));
    const reveal = useReveal();
    if (!sub)
        return null;
    return (_jsxs("button", { type: "button", className: "at-request-from", title: "Show the subagent", onClick: () => reveal(sub.id), children: [_jsx(BotIcon, { size: 12 }), " from ", subagentTitle(sub.call)] }));
}
/**
 * Runs a command, noting while it's under way (when onCommand returns a promise) and why it failed.
 * The card goes once its request resolves; answering one that's already answered does nothing.
 */
function useSending() {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const fail = (e) => setError(e instanceof Error ? e.message : String(e));
    const run = (send) => {
        setError(null);
        try {
            const p = send();
            if (!p || typeof p.then !== "function")
                return;
            setBusy(true);
            p.then(() => setBusy(false), (e) => {
                setBusy(false);
                fail(e);
            });
        }
        catch (e) {
            fail(e);
        }
    };
    return { busy, error, run };
}
// ---------- permissions ----------
/** A tool call the agent wants to make: allow it (once, or always for this tool) or deny it, with a note for the agent. */
export const PermissionCard = memo(function PermissionCard({ request, className }) {
    const respond = useRespond();
    const config = useThreadConfig();
    const harness = useThreadState((s) => s.snapshot.thread.harness);
    const cwd = useThreadState((s) => s.snapshot.thread.cwd);
    const found = useThreadState((s) => (request.tool_call_id ? findCall(s, request.tool_call_id) : undefined));
    const call = found ?? { id: request.id, type: "tool_call", name: request.name, kind: request.kind, input: request.input, status: "pending", title: request.title };
    const renderer = toolRenderer(config, call);
    const meta = { ...toolMeta(call, cwd), ...renderer.meta?.(call, cwd) };
    const Body = permissionBody(renderer);
    const { busy, error, run } = useSending();
    const [noting, setNoting] = useState(false);
    const [note, setNote] = useState("");
    if (request.resolution)
        return (_jsxs("div", { className: cx("at-card", "at-permission", "at-card-done", className), role: "group", "aria-label": `Permission for ${request.name}`, children: [_jsxs("div", { className: "at-card-head", children: [_jsx(ShieldIcon, { size: 15, className: "at-faint" }), _jsxs("span", { children: [asker(harness), " asked to use ", _jsx("span", { className: "at-mono", children: request.name })] }), meta.summary && _jsx("span", { className: "at-permission-summary at-card-done-summary", children: meta.summary }), _jsx(Outcome, { resolution: request.resolution })] }), request.resolution.message && _jsx("div", { className: "at-card-note", children: request.resolution.message })] }));
    const decide = (outcome, always = false) => run(() => respond(request.id, { outcome, ...(always ? { always } : {}), ...(outcome === "deny" && note.trim() ? { message: note.trim() } : {}) }));
    return (_jsxs("div", { className: cx("at-card", "at-permission", className), role: "group", "aria-label": `Permission for ${request.name}`, children: [_jsxs("div", { className: "at-card-head", children: [_jsx(ShieldIcon, { size: 15, className: "at-attention" }), _jsxs("span", { children: [asker(harness), " wants to use ", _jsx("span", { className: "at-mono", children: request.name })] }), _jsx(From, { parentId: request.parent_id })] }), meta.summary && (_jsxs("div", { className: "at-permission-target", children: [_jsx("span", { className: "at-tool-icon", children: meta.icon }), _jsx("span", { className: "at-permission-summary", children: meta.summary })] })), request.title && request.title !== meta.summary && _jsx("div", { className: "at-permission-title", children: request.title }), request.reason && _jsx("div", { className: "at-card-reason", children: request.reason }), _jsx(Body, { call: call }), noting && (_jsx("input", { className: "at-input", "aria-label": "A note for the agent", placeholder: "Tell the agent why (optional)", value: note, disabled: busy, autoFocus: true, onChange: (e) => setNote(e.target.value), onKeyDown: (e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        decide("deny");
                    }
                } })), _jsxs("div", { className: "at-card-actions", children: [_jsxs(Button, { variant: "primary", disabled: busy, onClick: () => decide("allow"), children: [_jsx(CheckIcon, { size: 13 }), " Allow"] }), _jsxs(Button, { disabled: busy, onClick: () => decide("allow", true), children: ["Always allow ", request.name, " in this thread"] }), _jsx(Button, { variant: "danger", disabled: busy, onClick: () => decide("deny"), children: "Deny" }), !noting && (_jsx("button", { type: "button", className: "at-link", disabled: busy, onClick: () => setNoting(true), children: "Deny with a note" })), error && _jsx("span", { className: "at-error", children: error })] })] }));
});
// ---------- plans ----------
/** The modes a plan can be approved into. */
const AFTER_PLAN = [
    { mode: "default", label: "asking as usual" },
    { mode: "accept_edits", label: "accepting edits" },
    { mode: "bypass", label: "asking nothing" },
];
/**
 * The agent's plan: approve it, and the agent starts on it in the mode picked (the thread's own, or
 * the default if that's plan); or keep planning, with feedback for the agent.
 */
export const PlanCard = memo(function PlanCard({ request, className }) {
    const respond = useRespond();
    const harness = useThreadState((s) => s.snapshot.thread.harness);
    const current = useThreadState((s) => s.snapshot.thread.permission_mode);
    const [mode, setMode] = useState(current && current !== "plan" ? current : "default");
    // The feedback being written, once the user's chosen to keep planning.
    const [feedback, setFeedback] = useState(null);
    const { busy, error, run } = useSending();
    const title = planTitle(request.plan);
    if (request.resolution)
        return (_jsxs("div", { className: cx("at-card", "at-plan-card", "at-card-done", className), role: "group", "aria-label": `Plan from ${asker(harness)}`, children: [_jsxs("div", { className: "at-card-head", children: [_jsx(MapIcon, { size: 15, className: "at-faint" }), _jsxs("span", { children: [asker(harness), "'s plan", title && _jsxs("span", { className: "at-plan-title", children: [": ", title] })] }), _jsx(Outcome, { resolution: request.resolution, plan: true })] }), request.resolution.message && _jsx("div", { className: "at-card-note", children: request.resolution.message })] }));
    const approve = () => run(() => respond(request.id, { outcome: "allow", permission_mode: mode }));
    const keepPlanning = () => run(() => respond(request.id, { outcome: "deny", ...(feedback?.trim() ? { message: feedback.trim() } : {}) }));
    return (_jsxs("div", { className: cx("at-card", "at-plan-card", className), role: "group", "aria-label": `Plan from ${asker(harness)}`, children: [_jsxs("div", { className: "at-card-head", children: [_jsx(MapIcon, { size: 15, className: "at-attention" }), _jsxs("span", { children: [asker(harness), " has a plan", title && _jsxs("span", { className: "at-plan-title", children: [": ", title] })] }), _jsx(From, { parentId: request.parent_id })] }), _jsx("div", { className: "at-plan-scroll", children: request.plan ? _jsx(Markdown, { text: request.plan, className: "at-plan" }) : _jsx("span", { className: "at-faint", children: "(The plan is empty.)" }) }), feedback === null ? (_jsxs("div", { className: "at-card-actions", children: [_jsxs(Button, { variant: "primary", disabled: busy, onClick: approve, children: [_jsx(CheckIcon, { size: 13 }), " Approve"] }), _jsxs("label", { className: "at-plan-mode", children: ["and carry on", _jsx("select", { className: "at-select", value: mode, disabled: busy, "aria-label": "The mode to carry on in", onChange: (e) => setMode(e.target.value), children: AFTER_PLAN.map((m) => (_jsx("option", { value: m.mode, children: m.label }, m.mode))) })] }), _jsx(Button, { disabled: busy, onClick: () => setFeedback(""), children: "Keep planning" }), error && _jsx("span", { className: "at-error", children: error })] })) : (_jsxs(_Fragment, { children: [_jsx("textarea", { className: "at-input at-textarea", "aria-label": "Feedback on the plan", placeholder: "What should the plan do differently? (optional)", value: feedback, disabled: busy, autoFocus: true, rows: 3, onChange: (e) => setFeedback(e.target.value), onKeyDown: (e) => {
                            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                                e.preventDefault();
                                keepPlanning();
                            }
                        } }), _jsxs("div", { className: "at-card-actions", children: [_jsxs(Button, { variant: "primary", disabled: busy, onClick: keepPlanning, children: [_jsx(SendIcon, { size: 13 }), " Keep planning"] }), _jsx(Button, { disabled: busy, onClick: () => setFeedback(null), children: "Back" }), error && _jsx("span", { className: "at-error", children: error })] })] }))] }));
});
const NO_DRAFT = { picked: [], other: "" };
/** Whether a question takes a typed answer: one with no options, or that allows another. */
const takesOther = (q) => !q.options?.length || !!q.allow_other;
/** A question's answer from its draft: a typed answer goes with the options ticked, or in place of the one picked. */
function answerOf(q, d) {
    const typed = d.other.trim() ? [d.other.trim()] : [];
    return q.multi_select ? [...d.picked, ...typed] : typed.length ? typed : d.picked;
}
/**
 * The agent's questions, each with its options to pick from (one, or several with multi_select),
 * and a typed answer where it takes one. Keys 1–9 pick in the question that's current; picking the
 * one answer of a question moves on to the next, and answers a lone question outright.
 */
export const QuestionCard = memo(function QuestionCard({ request, className }) {
    const respond = useRespond();
    const harness = useThreadState((s) => s.snapshot.thread.harness);
    const questions = request.questions;
    const [drafts, setDrafts] = useState(() => questions.map(() => NO_DRAFT));
    const [current, setCurrent] = useState(0);
    const { busy, error, run } = useSending();
    const ref = useRef(null);
    const answers = questions.map((q, i) => answerOf(q, drafts[i] ?? NO_DRAFT));
    const complete = answers.every((a) => a.length > 0);
    const submit = (list = answers) => run(() => respond(request.id, { outcome: "answer", answers: Object.fromEntries(questions.map((q, i) => [q.id, list[i] ?? []])) }));
    const dismiss = () => run(() => respond(request.id, { outcome: "cancel" }));
    const set = (i, d) => setDrafts((all) => all.map((x, j) => (j === i ? { ...x, ...d } : x)));
    const pick = (i, label) => {
        const q = questions[i];
        if (!q || busy)
            return;
        const d = drafts[i] ?? NO_DRAFT;
        if (q.multi_select)
            return set(i, { picked: d.picked.includes(label) ? d.picked.filter((x) => x !== label) : [...d.picked, label] });
        const next = drafts.map((x, j) => (j === i ? { picked: [label], other: "" } : x));
        setDrafts(next);
        if (questions.length === 1)
            return submit([[label]]);
        // On to the next question that isn't answered yet.
        const after = questions.findIndex((qq, j) => j > i && !answerOf(qq, next[j] ?? NO_DRAFT).length);
        setCurrent(after >= 0 ? after : i);
    };
    useDigitKeys(!busy && !request.resolution, ref, (n) => {
        const o = questions[current]?.options?.[n - 1];
        if (o)
            pick(current, o.label);
    });
    const who = asker(harness);
    if (request.resolution)
        return _jsx(AnsweredQuestions, { request: request, resolution: request.resolution, who: who, className: className });
    return (_jsxs("div", { ref: ref, className: cx("at-card", "at-question", className), role: "group", "aria-label": `Questions from ${who}`, children: [_jsxs("div", { className: "at-card-head", children: [_jsx(QuestionIcon, { size: 15, className: "at-attention" }), _jsxs("span", { children: [who, " ", questions.length === 1 ? "asks" : `asks ${questions.length} questions`] }), _jsx(From, { parentId: request.parent_id })] }), _jsx("div", { className: "at-questions", children: questions.map((q, i) => {
                    const d = drafts[i] ?? NO_DRAFT;
                    const options = q.options ?? [];
                    const multi = !!q.multi_select;
                    const picked = multi ? d.picked : d.other.trim() ? [] : d.picked;
                    const active = i === current && questions.length > 1;
                    return (_jsxs("div", { className: cx("at-q", questions.length > 1 && "at-q-many", active && "at-q-current"), onFocusCapture: () => setCurrent(i), onMouseDown: () => setCurrent(i), children: [_jsxs("div", { className: "at-q-title", children: [q.header && _jsx("span", { className: "at-q-header", children: q.header }), _jsx("span", { className: "at-q-text", children: q.question }), multi && _jsx("span", { className: "at-faint at-small", children: "pick any" })] }), options.length > 0 && (_jsx("div", { className: "at-choices", role: multi ? "group" : "radiogroup", "aria-label": q.question, children: options.map((o, j) => (_jsx(Choice, { label: o.label, description: o.description, n: j + 1, multi: multi, picked: picked.includes(o.label), keys: i === current || questions.length === 1, disabled: busy, onPick: () => pick(i, o.label) }, o.label))) })), takesOther(q) && (_jsx("input", { type: q.secret ? "password" : "text", className: cx("at-input", d.other.trim() && "at-input-filled"), "aria-label": `Your own answer to: ${q.question}`, value: d.other, disabled: busy, autoComplete: q.secret ? "off" : undefined, placeholder: options.length ? (multi ? "Something else too (optional)" : "Other: your own answer") : "Your answer", onChange: (e) => set(i, { other: e.target.value }), onKeyDown: (e) => {
                                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                                        e.preventDefault();
                                        if (complete)
                                            submit();
                                    }
                                } }))] }, q.id));
                }) }), _jsxs("div", { className: "at-card-actions", children: [_jsxs(Button, { variant: "primary", disabled: busy || !complete, onClick: () => submit(), children: [_jsx(SendIcon, { size: 13 }), " ", questions.length === 1 ? "Answer" : "Submit answers"] }), _jsxs(Button, { disabled: busy, onClick: dismiss, title: "Tell the agent you won't answer", children: [_jsx(XIcon, { size: 13 }), " Dismiss"] }), questions[current]?.options?.length ? _jsx("span", { className: "at-faint at-small", children: "Keys 1\u20139 pick an answer." }) : null, error && _jsx("span", { className: "at-error", children: error })] })] }));
});
/** Questions that have been answered (or weren't): each with the options picked ticked, and any typed answer. */
function AnsweredQuestions({ request, resolution, who, className }) {
    const questions = request.questions;
    return (_jsxs("div", { className: cx("at-card", "at-question", "at-card-done", className), role: "group", "aria-label": `Questions from ${who}`, children: [_jsxs("div", { className: "at-card-head", children: [_jsx(QuestionIcon, { size: 15, className: "at-faint" }), _jsxs("span", { children: [who, " ", questions.length === 1 ? "asked" : `asked ${questions.length} questions`] }), _jsx(Outcome, { resolution: resolution })] }), _jsx("div", { className: "at-questions", children: questions.map((q) => {
                    const answer = resolution.answers?.[q.id] ?? [];
                    const options = q.options ?? [];
                    const typed = answer.filter((a) => !options.some((o) => o.label === a));
                    return (_jsxs("div", { className: cx("at-q", questions.length > 1 && "at-q-many"), children: [_jsxs("div", { className: "at-q-title", children: [q.header && _jsx("span", { className: "at-q-header", children: q.header }), _jsx("span", { className: "at-q-text", children: q.question })] }), options.length > 0 && (_jsx("div", { className: "at-choices", role: q.multi_select ? "group" : "radiogroup", "aria-label": q.question, children: options.map((o, j) => (_jsx(Choice, { label: o.label, description: o.description, n: j + 1, multi: !!q.multi_select, picked: answer.includes(o.label), keys: false }, o.label))) })), typed.length > 0 && _jsx("div", { className: "at-card-note", children: q.secret ? "••••••" : typed.join("\n") })] }, q.id));
                }) }), resolution.message && _jsx("div", { className: "at-card-note", children: resolution.message })] }));
}
/** One of a question's options: a numbered row (its number is its key), ticked when it's picked; without onPick, it's only shown. */
function Choice({ label, description, n, picked, multi, onPick, disabled, keys }) {
    return (_jsxs("button", { type: "button", role: multi ? "checkbox" : "radio", "aria-checked": picked, disabled: disabled || !onPick, onClick: onPick, className: cx("at-choice", picked && "at-choice-picked"), children: [_jsx("span", { className: cx("at-choice-mark", multi ? "at-choice-box" : "at-choice-dot"), "aria-hidden": true, children: picked ? _jsx(CheckIcon, { size: 11 }) : keys && n <= 9 ? n : "" }), _jsxs("span", { className: "at-choice-text", children: [_jsx("span", { className: "at-choice-label", children: label }), description && description !== label && _jsx("span", { className: "at-choice-description", children: description })] })] }));
}
const keyed = new Set();
let mounted = 0;
function onDigit(e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.repeat || !/^[1-9]$/.test(e.key))
        return;
    const t = e.target;
    // Typing a number somewhere.
    if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)))
        return;
    const shown = [...keyed].filter((k) => !!k.el()?.getClientRects().length);
    if (!shown.length)
        return;
    const card = shown.reduce((a, b) => (b.n > a.n ? b : a));
    // Not one behind a dialog it isn't in.
    const dialogs = document.querySelectorAll('[aria-modal="true"]');
    if (dialogs.length && !dialogs[dialogs.length - 1].contains(card.el()))
        return;
    e.preventDefault();
    card.pick(Number(e.key));
}
/** While `on`, keys 1–9 call `pick` for the card `ref` is on, if it's the latest such card. */
function useDigitKeys(on, ref, pick) {
    const latest = useRef(pick);
    latest.current = pick;
    const [n] = useState(() => ++mounted);
    useEffect(() => {
        if (!on)
            return;
        const entry = { n, el: () => ref.current, pick: (k) => latest.current(k) };
        if (!keyed.size)
            document.addEventListener("keydown", onDigit);
        keyed.add(entry);
        return () => {
            keyed.delete(entry);
            if (!keyed.size)
                document.removeEventListener("keydown", onDigit);
        };
    }, [n, on, ref]);
}
