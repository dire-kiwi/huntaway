import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// How many of the thread's subagents are running and done, opening a list of them; picking one
// shows its row in the thread.
import { useEffect, useRef, useState } from "react";
import { useReveal, useThreadState } from "../hooks.js";
import { BotIcon, ChevronIcon, SpinnerIcon } from "../icons.js";
import { SubagentStatusBadge, subagentKind, subagentTitle } from "./Subagent.js";
import { cx } from "./ui.js";
export function AgentsPill({ className, onSelect }) {
    const subagents = useThreadState((s) => s.view.subagents);
    const reveal = useReveal();
    const [open, setOpen] = useState(false);
    const root = useRef(null);
    useEffect(() => {
        if (!open)
            return;
        const onDown = (e) => {
            if (!root.current?.contains(e.target))
                setOpen(false);
        };
        const onKey = (e) => {
            if (e.key !== "Escape")
                return;
            e.preventDefault();
            setOpen(false);
        };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey, true);
        return () => {
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("keydown", onKey, true);
        };
    }, [open]);
    if (subagents.size === 0)
        return null;
    const all = [...subagents.values()];
    const running = all.filter((s) => s.status === "running").length;
    const settled = all.length - running;
    // Newest first, running ones on top.
    const list = all.reverse().sort((a, b) => Number(b.status === "running") - Number(a.status === "running"));
    return (_jsxs("div", { ref: root, className: cx("at-agents", className), children: [_jsxs("button", { type: "button", className: cx("at-agents-pill", running > 0 && "at-agents-running"), "aria-expanded": open, onClick: () => setOpen(!open), title: "Subagents in this thread", children: [running ? _jsx(SpinnerIcon, { size: 12, className: "at-spin at-progress" }) : _jsx(BotIcon, { size: 13 }), "Agents", _jsx("span", { className: "at-faint", children: [running > 0 && `${running} running`, settled > 0 && `${settled} done`].filter(Boolean).join(" · ") }), _jsx(ChevronIcon, { size: 11, className: "at-chevron at-chevron-down" })] }), open && (_jsx("div", { className: "at-agents-menu", role: "menu", children: list.map((s) => (_jsxs("button", { type: "button", role: "menuitem", className: "at-agents-item", onClick: () => {
                        setOpen(false);
                        (onSelect ?? reveal)(s.id);
                    }, children: [_jsx(BotIcon, { size: 13 }), _jsxs("span", { className: "at-agents-text", children: [_jsx("span", { className: "at-agents-title", children: subagentTitle(s.call) }), _jsx("span", { className: "at-agents-meta", children: [subagentKind(s.call), s.background && "background", s.toolUses > 0 && `${s.toolUses} tool uses`].filter(Boolean).join(" · ") })] }), _jsx(SubagentStatusBadge, { status: s.status, waiting: s.waiting })] }, s.id))) }))] }));
}
