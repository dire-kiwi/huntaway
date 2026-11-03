import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { memo, useState } from "react";
import { AlertIcon, LayersIcon } from "../icons.js";
import { Chevron, CodeBlock, cost, cx, Markdown, seconds, tokens } from "./ui.js";
/** The harness compacted its context: how big it was, and the summary it goes on from (which opens). */
export const CompactionLine = memo(function CompactionLine({ item, className }) {
    const [open, setOpen] = useState(false);
    const summary = item.summary;
    return (_jsxs("div", { className: cx("at-line", "at-compaction", className), children: [_jsxs("button", { type: "button", className: "at-line-rule", disabled: !summary, "aria-expanded": summary ? open : undefined, onClick: () => setOpen(!open), children: [_jsx("span", { className: "at-rule" }), _jsx(LayersIcon, { size: 12 }), item.trigger === "auto" ? "Context full, conversation compacted" : "Conversation compacted", item.tokens_before != null && ` · ${tokens(item.tokens_before)} tokens`, summary && _jsx(Chevron, { open: open, size: 11 }), _jsx("span", { className: "at-rule" })] }), open && summary && (_jsx("div", { className: "at-compaction-summary", children: _jsx(Markdown, { text: summary }) }))] }));
});
/** What a turn's usage comes to, e.g. "1.2k in · 300 out · $0.003". */
export function usageText(usage) {
    const input = usage.input_tokens + (usage.cache_read_tokens ?? 0) + (usage.cache_write_tokens ?? 0);
    return [`${tokens(input)} in`, `${tokens(usage.output_tokens)} out`, usage.cost_usd != null && cost(usage.cost_usd)].filter(Boolean).join(" · ");
}
/** How a turn ended: done, interrupted or failed, how long it took and what it used. */
export const TurnResult = memo(function TurnResult({ item, className }) {
    const error = !item.ok && !item.interrupted;
    const bits = [item.duration_ms != null && seconds(item.duration_ms), item.usage && usageText(item.usage)].filter(Boolean);
    return (_jsx("div", { className: cx("at-line", "at-turn-result", error && "at-turn-error", className), title: item.error, children: _jsxs("div", { className: "at-line-rule", children: [_jsx("span", { className: "at-rule" }), item.interrupted ? "Interrupted" : error ? `Failed${item.error ? `: ${firstLine(item.error)}` : ""}` : "Turn complete", bits.map((b) => ` · ${b}`).join(""), _jsx("span", { className: "at-rule" })] }) }));
});
const firstLine = (s) => {
    const line = s.split("\n")[0];
    return line.length > 120 ? line.slice(0, 119) + "…" : line;
};
/** Something to tell the user that isn't the agent talking; its detail opens. */
export const Notice = memo(function Notice({ item, className }) {
    const [open, setOpen] = useState(false);
    const detail = item.detail;
    return (_jsxs("div", { className: cx("at-notice", `at-notice-${item.level}`, className), "data-code": item.code, children: [_jsxs("button", { type: "button", className: "at-notice-head", disabled: !detail, "aria-expanded": detail ? open : undefined, onClick: () => setOpen(!open), children: [item.level === "info" ? _jsx("span", { className: "at-dot" }) : _jsx(AlertIcon, { size: 12 }), _jsx("span", { className: "at-notice-text", children: item.text }), detail && _jsx(Chevron, { open: open, size: 11 })] }), open && detail && _jsx(CodeBlock, { text: detail, tone: item.level === "error" ? "error" : undefined })] }));
});
