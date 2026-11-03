import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { memo, useMemo, useRef } from "react";
import { useThreadConfig, useThreadState } from "../hooks.js";
import { BrainIcon, ClockIcon } from "../icons.js";
import { groupRows, NO_ITEMS, rowKey } from "../view.js";
import { CompactionLine, Notice, TurnResult } from "./Lines.js";
import { RequestCard } from "./Requests.js";
import { StreamingText } from "./StreamingText.js";
import { ToolCall, ToolGroup, toolRenderer } from "./ToolCall.js";
import { Collapsible, cx, Markdown } from "./ui.js";
/** The rows of the thread (or, given `parentId`, of that subagent's own thread). */
export const MessageList = memo(function MessageList({ parentId = "", className }) {
    const items = useThreadState((s) => s.view.children.get(parentId) ?? NO_ITEMS);
    const answered = useThreadState((s) => s.view.answered.get(parentId) ?? NO_REQUESTS);
    const config = useThreadConfig();
    const alone = useMemo(() => {
        if (!config.tools && !config.toolKinds)
            return undefined;
        return (call) => !!toolRenderer(config, call).alone;
    }, [config]);
    const prev = useRef(undefined);
    const rows = useMemo(() => (prev.current = groupRows(items, prev.current, alone, answered)), [items, alone, answered]);
    return (_jsx("div", { className: cx("at-message-list", className), children: rows.map((row) => (_jsx(MessageRow, { row: row }, rowKey(row)))) }));
});
const NO_REQUESTS = [];
/** One row: an item, a group of tool calls, or an answered request. */
export const MessageRow = memo(function MessageRow({ row }) {
    const { renderItem } = useThreadConfig();
    if (row.type === "tool_group")
        return _jsx(ToolGroup, { group: row });
    if (row.type === "request")
        return _jsx(RequestCard, { request: row.request });
    const custom = renderItem?.(row);
    if (custom !== undefined)
        return _jsx(_Fragment, { children: custom });
    return _jsx(ItemView, { item: row });
});
/** The built-in row for an item. */
export function ItemView({ item }) {
    switch (item.type) {
        case "user_message":
            return _jsx(UserMessage, { item: item });
        case "assistant_message":
            return _jsx(AssistantMessage, { item: item });
        case "reasoning":
            return _jsx(Reasoning, { item: item });
        case "tool_call":
            return _jsx(ToolCall, { call: item });
        case "compaction":
            return _jsx(CompactionLine, { item: item });
        case "notice":
            return _jsx(Notice, { item: item });
        case "turn_result":
            return _jsx(TurnResult, { item: item });
        default:
            return null;
    }
}
/** A message to the agent: steered ones joined a running turn, queued ones are waiting for the agent to take them in. */
export function UserMessage({ item, className }) {
    return (_jsxs("div", { className: cx("at-user", item.queued && "at-user-queued", className), children: [_jsxs("div", { className: "at-user-bubble", title: item.steered ? "Sent while the agent was working; it read it here" : undefined, children: [item.text, item.attachments?.length ? _jsx(Attachments, { list: item.attachments }) : null] }), (item.queued || item.steered) && (_jsx("div", { className: "at-user-note", children: item.queued ? (_jsxs(_Fragment, { children: [_jsx(ClockIcon, { size: 11 }), " Waiting for the agent to read it"] })) : ("Sent while it worked") }))] }));
}
function Attachments({ list }) {
    return (_jsx("div", { className: "at-attachments", children: list.map((a, i) => a.kind === "image" && a.data ? (_jsx("img", { className: "at-attachment-image", alt: a.name ?? "image", src: `data:${a.media_type ?? "image/png"};base64,${a.data}` }, i)) : (_jsx("span", { className: "at-attachment", children: a.name ?? a.path?.split("/").pop() ?? a.kind }, i))) }));
}
/** The agent's reply: plain text while it streams in, then Markdown. */
export function AssistantMessage({ item, className }) {
    const streaming = useThreadState((s) => s.streaming.has(item.id));
    if (streaming)
        return _jsx(StreamingText, { text: item.text, className: cx("at-assistant", className) });
    return _jsx(Markdown, { text: item.text, className: cx("at-assistant", className) });
}
/** The agent's thinking, folded away. */
export function Reasoning({ item, className }) {
    const streaming = useThreadState((s) => s.streaming.has(item.id));
    return (_jsx(Collapsible, { label: streaming ? "Thinking…" : "Thinking", icon: _jsx(BrainIcon, {}), className: cx("at-reasoning", className), children: _jsx("div", { className: "at-pre-wrap", children: item.text }) }));
}
