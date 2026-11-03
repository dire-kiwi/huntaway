import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// Where the user writes to the agent. With no turn running a message starts one; with one running
// it steers it (the agent reads it after its current step), and the stop button interrupts it.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useInterrupt, useSend, useThreadState } from "../hooks.js";
import { ArrowUpIcon, SpinnerIcon, StopIcon } from "../icons.js";
import { cx } from "./ui.js";
/** `typed` once `sent` has gone: what was typed after it while it was sending, or all of it if what was sent was changed. */
export const afterSent = (typed, sent) => sent && typed.startsWith(sent) ? typed.slice(sent.length).replace(/^\s+/, "") : typed;
export function Composer({ placeholder, className, children, enterSends = true, autoFocus }) {
    const thread = useThreadState((s) => s.snapshot.thread);
    const send = useSend();
    const interrupt = useInterrupt();
    const [text, setText] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const ref = useRef(null);
    const running = thread.status === "running" || thread.status === "waiting";
    const fit = () => {
        const el = ref.current;
        if (!el)
            return;
        el.style.height = "0px";
        el.style.height = Math.min(el.scrollHeight, 260) + "px";
    };
    useLayoutEffect(fit, [text]);
    useEffect(() => {
        const el = ref.current;
        if (!el || typeof ResizeObserver === "undefined")
            return;
        let width = el.clientWidth;
        const ro = new ResizeObserver(() => {
            if (el.clientWidth === width)
                return;
            width = el.clientWidth;
            fit();
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    const fail = (e) => setError(e instanceof Error ? e.message : String(e));
    const submit = () => {
        const sent = text;
        if (!sent.trim() || busy)
            return;
        setError(null);
        let p;
        try {
            p = send(sent.trim());
        }
        catch (e) {
            return fail(e);
        }
        if (!p || typeof p.then !== "function")
            return setText((cur) => afterSent(cur, sent));
        setBusy(true);
        p.then(() => {
            setBusy(false);
            setText((cur) => afterSent(cur, sent));
        }, (e) => {
            setBusy(false);
            fail(e);
        });
    };
    const stop = () => {
        setError(null);
        try {
            const p = interrupt();
            if (p && typeof p.then === "function")
                p.then(undefined, (e) => fail(`Couldn't stop the agent: ${e instanceof Error ? e.message : String(e)}`));
        }
        catch (e) {
            fail(e);
        }
    };
    const details = [thread.model, thread.effort && `${thread.effort} effort`].filter(Boolean).join(" · ");
    const sendButton = (_jsx("button", { type: "button", className: "at-composer-send", onClick: submit, disabled: busy || !text.trim(), title: running ? "Send to the agent now" : "Send", "aria-label": "Send", children: busy ? _jsx(SpinnerIcon, { size: 14, className: "at-spin" }) : _jsx(ArrowUpIcon, { size: 15 }) }));
    return (_jsxs("div", { className: cx("at-composer", className), children: [error && _jsx("div", { className: "at-error at-composer-error", children: error }), _jsxs("div", { className: "at-composer-box", children: [_jsx("textarea", { ref: ref, rows: 1, value: text, autoFocus: autoFocus, "aria-label": "Message the agent", placeholder: placeholder ?? (running ? "Message the agent: it reads it after its current step…" : "Message the agent…"), onChange: (e) => setText(e.target.value), onKeyDown: (e) => {
                            if (e.key !== "Enter" || e.nativeEvent.isComposing)
                                return;
                            if (e.ctrlKey || e.metaKey || (enterSends && !e.shiftKey)) {
                                e.preventDefault();
                                submit();
                            }
                        } }), _jsxs("div", { className: "at-composer-bar", children: [children, details && _jsx("span", { className: "at-composer-details", children: details }), _jsx("div", { className: "at-composer-actions", children: running ? (_jsxs(_Fragment, { children: [text.trim() && sendButton, _jsx("button", { type: "button", className: "at-composer-stop", onClick: stop, title: "Stop the agent", "aria-label": "Stop", children: _jsx(StopIcon, { size: 11 }) })] })) : (sendButton) })] })] })] }));
}
