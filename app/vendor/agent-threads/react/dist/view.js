// A thread's items arranged for drawing: each list of items (the main thread's, and each
// subagent's), what's known of each subagent, the open requests by the tool call they're for, and
// the answered requests by the list they're drawn in.
// It's rebuilt for each change, keeping what the change left as it was (lists, subagents, rows) as
// the same objects, so the rows showing them don't redraw. applyEvent does the same for items.
export const NO_ITEMS = Object.freeze([]);
/** The view of `items` and `requests`, keeping what's unchanged from `prev` (the view of an earlier state). */
export function buildView(items, requests, prev) {
    const children = new Map([["", []]]);
    for (const item of items) {
        const parent = item.parent_id ?? "";
        const list = children.get(parent);
        if (list)
            list.push(item);
        else
            children.set(parent, [item]);
    }
    const lists = children;
    if (prev) {
        for (const [id, list] of children) {
            const old = prev.children.get(id);
            if (old && sameList(old, list))
                lists.set(id, old);
        }
    }
    const waiting = new Set();
    const requestsByCall = new Map();
    const answered = new Map();
    for (const r of requests) {
        if (r.resolution) {
            const list = answered.get(r.parent_id ?? "");
            if (list)
                list.push(r);
            else
                answered.set(r.parent_id ?? "", [r]);
            continue;
        }
        if (r.parent_id)
            waiting.add(r.parent_id);
        if (r.tool_call_id)
            requestsByCall.set(r.tool_call_id, r);
    }
    if (prev) {
        for (const [id, list] of answered) {
            const old = prev.answered.get(id);
            if (old && sameList(old, list))
                answered.set(id, old);
        }
    }
    const subagents = new Map();
    for (const item of items) {
        if (item.type !== "tool_call" || item.kind !== "subagent")
            continue;
        const own = lists.get(item.id) ?? NO_ITEMS;
        const info = {
            id: item.id,
            call: item,
            items: own,
            status: subagentStatus(item),
            background: !!item.subagent?.background,
            toolUses: item.subagent?.tool_uses ?? own.reduce((n, i) => (i.type === "tool_call" ? n + 1 : n), 0),
            waiting: waiting.has(item.id),
            parent: item.parent_id,
        };
        const old = prev?.subagents.get(item.id);
        subagents.set(item.id, old && shallowEqual(old, info) ? old : info);
    }
    return {
        children: prev && sameMap(prev.children, lists) ? prev.children : lists,
        subagents: prev && sameMap(prev.subagents, subagents) ? prev.subagents : subagents,
        requestsByCall: prev && sameMap(prev.requestsByCall, requestsByCall) ? prev.requestsByCall : requestsByCall,
        answered: prev && sameMap(prev.answered, answered) ? prev.answered : answered,
    };
}
/** The subagent's own status where the harness gives it (a background one's call has completed), or its call's. */
function subagentStatus(call) {
    if (call.subagent)
        return call.subagent.status;
    switch (call.status) {
        case "pending":
        case "running":
            return "running";
        case "completed":
            return "completed";
        case "failed":
            return "failed";
        default:
            return "stopped";
    }
}
/** A subagent and the subagents that started it, innermost first. */
export function lineage(subagents, id) {
    const out = [];
    for (let cur = id; cur && !out.includes(cur); cur = subagents.get(cur)?.parent)
        out.push(cur);
    return out;
}
export const rowKey = (row) => (row.type === "tool_group" ? `g:${row.key}` : row.type === "request" ? `r:${row.request.id}` : row.id);
/**
 * The rows to draw for a list of items: tool calls in a row become a group (except those `alone`
 * says to show by themselves), and assistant messages and reasoning with no text yet are left out.
 * `answered` (the list's resolved requests) are drawn where they were asked: a permission just
 * before its tool call, a question in place of its call (the card has the answers), one without a
 * call in the list after the last item of its turn, and one with neither at the end. Rows
 * unchanged from `prev` (the rows of an earlier version of the list) are its, and so is the list
 * if they all are; a group keeps the key it had in `prev`.
 */
export function groupRows(items, prev, alone, answered = NO_REQUESTS) {
    // Where each answered request goes: at a call (before it, or in its place), or after an item.
    const atCall = new Map();
    const after = new Map();
    if (answered.length) {
        const at = new Map();
        items.forEach((item, i) => at.set(item.id, i));
        for (const r of answered) {
            const call = r.tool_call_id !== undefined ? at.get(r.tool_call_id) : undefined;
            if (call !== undefined && items[call].type === "tool_call" && !atCall.has(r.tool_call_id)) {
                atCall.set(r.tool_call_id, r);
                continue;
            }
            let last = items.length - 1;
            if (r.turn_id)
                for (let i = items.length - 1; i >= 0; i--)
                    if (items[i].turn_id === r.turn_id) {
                        last = i;
                        break;
                    }
            const list = after.get(last);
            if (list)
                list.push(r);
            else
                after.set(last, [r]);
        }
    }
    const old = new Map();
    const oldRequests = new Map();
    const keyOf = new Map();
    for (const r of prev ?? []) {
        if (r.type === "tool_group") {
            old.set(r.key, r);
            for (const c of r.calls)
                keyOf.set(c.id, r.key);
        }
        else if (r.type === "request")
            oldRequests.set(r.request.id, r);
    }
    const rows = [];
    const used = new Set();
    let group = null;
    const request = (r) => {
        group = null;
        const was = oldRequests.get(r.id);
        rows.push(was && was.request === r ? was : { type: "request", request: r });
    };
    const pending = after.get(-1);
    if (pending)
        pending.forEach(request);
    items.forEach((item, i) => {
        const asked = item.type === "tool_call" ? atCall.get(item.id) : undefined;
        if (asked)
            request(asked);
        if (asked?.type === "question") {
            // The card has the answers.
        }
        else if ((item.type === "assistant_message" || item.type === "reasoning") && !item.text.trim()) {
            // Nothing to show yet.
        }
        else if (item.type === "tool_call" && !alone?.(item)) {
            if (group)
                group.push(item);
            else
                rows.push({ type: "tool_group", key: item.id, calls: (group = [item]) });
        }
        else {
            group = null;
            rows.push(item);
        }
        after.get(i)?.forEach(request);
    });
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (r.type !== "tool_group")
            continue;
        // The key of the group one of its calls was in, unless an earlier group has taken it.
        let key = r.calls.map((c) => keyOf.get(c.id)).find((k) => k !== undefined && !used.has(k)) ?? r.key;
        if (used.has(key))
            key = `${r.key}:${i}`;
        used.add(key);
        const was = old.get(key);
        rows[i] = was && sameList(was.calls, r.calls) ? was : key === r.key ? r : { ...r, key };
    }
    if (!prev?.length)
        return rows;
    return rows.length === prev.length && rows.every((r, i) => r === prev[i]) ? prev : rows;
}
const NO_REQUESTS = Object.freeze([]);
// ---------- helpers ----------
function shallowEqual(a, b) {
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length)
        return false;
    return ka.every((k) => a[k] === b[k]);
}
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
function sameMap(a, b) {
    if (a.size !== b.size)
        return false;
    for (const [k, v] of b)
        if (a.get(k) !== v)
            return false;
    return true;
}
