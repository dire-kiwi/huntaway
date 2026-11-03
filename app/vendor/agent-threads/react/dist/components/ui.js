import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// Pieces the components share: class names, code blocks, collapsible sections, buttons and
// Markdown.
import { memo, useState } from "react";
import { useThreadConfig } from "../hooks.js";
import { ChevronIcon } from "../icons.js";
/** The class names that are set, joined. */
export const cx = (...names) => names.filter(Boolean).join(" ");
export function CodeBlock({ text, tone, className, tall }) {
    return (_jsx("pre", { className: cx("at-code", tone === "error" && "at-code-error", tall && "at-code-tall", className), children: text || _jsx("span", { className: "at-faint", children: "(empty)" }) }));
}
/** A section that opens when its label's clicked. */
export function Collapsible({ label, icon, children, className, defaultOpen = false }) {
    const [open, setOpen] = useState(defaultOpen);
    return (_jsxs("div", { className: cx("at-collapsible", className), children: [_jsxs("button", { type: "button", className: "at-collapsible-label", "aria-expanded": open, onClick: () => setOpen(!open), children: [icon, " ", label, _jsx(Chevron, { open: open, size: 11 })] }), open && _jsx("div", { className: "at-collapsible-body", children: children })] }));
}
export const Chevron = ({ open, size = 12 }) => (_jsx(ChevronIcon, { size: size, className: cx("at-chevron", open && "at-chevron-open") }));
export function Button({ variant, className, ...props }) {
    return _jsx("button", { type: "button", ...props, className: cx("at-button", variant && `at-button-${variant}`, className) });
}
/** Markdown, drawn by the app's renderMarkdown if it gave one. */
export const Markdown = memo(function Markdown({ text, className }) {
    const render = useThreadConfig().renderMarkdown;
    return _jsx("div", { className: cx("at-markdown", className), children: render ? render(text) : _jsx(PlainMarkdown, { text: text }) });
});
/**
 * Markdown without parsing it: fenced code blocks, paragraphs, and `code`. An app that wants the
 * rest passes renderMarkdown.
 */
function PlainMarkdown({ text }) {
    const parts = text.split(/^```[^\n]*\n([\s\S]*?)^```[ \t]*$/m);
    return (_jsx(_Fragment, { children: parts.map((part, i) => i % 2 ? (_jsx("pre", { className: "at-code", children: part.replace(/\n$/, "") }, i)) : (part
            .split(/\n{2,}/)
            .filter((p) => p.trim())
            .map((p, j) => _jsx("p", { children: inlineCode(p.trim()) }, `${i}.${j}`)))) }));
}
function inlineCode(text) {
    const bits = text.split(/`([^`\n]+)`/);
    return bits.length === 1 ? text : bits.map((b, i) => (i % 2 ? _jsx("code", { children: b }, i) : b));
}
// ---------- numbers ----------
export const tokens = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
export const seconds = (ms) => {
    const s = ms / 1000;
    return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
};
export const cost = (usd) => `$${usd.toFixed(usd < 0.01 ? 4 : 3)}`;
/** `n thing` or `n things`. */
export const plural = (n, thing) => `${n} ${thing}${n === 1 ? "" : "s"}`;
