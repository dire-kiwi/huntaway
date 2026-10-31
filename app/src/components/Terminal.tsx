import "@xterm/xterm/css/xterm.css";
import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import { Loader2, RotateCcw, Square, SquareTerminal, TerminalSquare, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, terminalWsUrl, type Task, type TerminalStatus, type TerminalTool } from "../api";
import { onThemeChange, resolvedTheme, type ResolvedTheme } from "../theme";
import { Button, copyText } from "./ui";

/**
 * A task's tmux session on its host, in xterm.js. The session lives on the host, so leaving
 * the page (or restarting the server) doesn't end it; reconnecting picks it up again.
 * With `tool`, the session runs one of the host's terminal tools instead of a shell; it lasts
 * while the board keeps it open (see terminalTools.ts) and `onClose` ends it.
 *
 * Wire format: binary frames carry terminal output and input; JSON text frames carry
 * `ready` (server), `resize` and `ack` (client). We acknowledge output once xterm has
 * processed it, and the server pauses while too much is unacknowledged.
 */

/** The terminal's colours in each of the board's themes (see theme.ts): the dark one on the board's code background. */
const THEMES: Record<ResolvedTheme, ITheme> = {
  dark: {
    background: "#0f0f12",
    foreground: "#ededf0",
    cursor: "#c4c4f8",
    cursorAccent: "#0f0f12",
    selectionBackground: "#8b8cf966",
    black: "#27272c",
    red: "#f87171",
    green: "#4ade80",
    yellow: "#facc15",
    blue: "#60a5fa",
    magenta: "#c084fc",
    cyan: "#22d3ee",
    white: "#d4d4dc",
    brightBlack: "#6f6f7b",
    brightRed: "#fca5a5",
    brightGreen: "#86efac",
    brightYellow: "#fde68a",
    brightBlue: "#93c5fd",
    brightMagenta: "#d8b4fe",
    brightCyan: "#67e8f9",
    brightWhite: "#f4f4f8",
  },
  light: {
    background: "#ffffff",
    foreground: "#1a1a20",
    cursor: "#4f46e5",
    cursorAccent: "#ffffff",
    selectionBackground: "#5553d844",
    black: "#1a1a20",
    red: "#c62828",
    green: "#1b7f3b",
    yellow: "#a16207",
    blue: "#1d4ed8",
    magenta: "#7e22ce",
    cyan: "#0e7490",
    white: "#c9c9d3",
    brightBlack: "#62626e",
    brightRed: "#dc2626",
    brightGreen: "#15803d",
    brightYellow: "#b45309",
    brightBlue: "#2563eb",
    brightMagenta: "#9333ea",
    brightCyan: "#0891b2",
    brightWhite: "#f5f5f7",
  },
};

const FONT_FAMILY = '"JetBrains Mono Variable", "Symbols Nerd Font Mono", monospace';

/** The bundled font loads lazily, and canvas text doesn't ask for it. */
const terminalFont: Promise<unknown> =
  document.fonts?.load('13px "JetBrains Mono Variable"').catch(() => {}) ?? Promise.resolve();

type Conn = { state: "connecting" } | { state: "open" } | { state: "ended" } | { state: "error"; message: string };

export function TerminalPane({ task, active, tool, onClose }: { task: Task; active: boolean; tool?: TerminalTool; onClose?: () => void }) {
  const toolId = tool?.id;
  const [status, setStatus] = useState<TerminalStatus | null>(null);
  const [conn, setConn] = useState<Conn>({ state: "connecting" });
  /** Bumped to start over with a fresh connection. */
  const [attempt, setAttempt] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const view = useRef<{ term: XTerm; fit: FitAddon } | null>(null);
  const available = status?.available;

  useEffect(() => {
    api
      .terminal(task.host_id, task.id, toolId)
      .then(setStatus)
      // Unreachable for a moment (e.g. restarting): keep what we knew and let the socket retry.
      .catch((e) => setStatus((s) => s ?? { available: false, running: false, reason: e.message }));
  }, [task.host_id, task.id, toolId, conn.state]);

  useEffect(() => {
    const el = box.current;
    if (!available || !el) return;
    let disposed = false;
    let ws: WebSocket | null = null;
    let retries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let unacked = 0;
    let ackTimer: ReturnType<typeof setTimeout> | undefined;
    const encoder = new TextEncoder();
    const cleanups: (() => void)[] = [];

    const send = (data: string | Uint8Array<ArrayBuffer>) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(data);
    };
    const flushAck = () => {
      clearTimeout(ackTimer);
      ackTimer = undefined;
      if (unacked > 0) send(JSON.stringify({ type: "ack", bytes: unacked }));
      unacked = 0;
    };
    const ack = (n: number) => {
      unacked += n;
      if (unacked >= 32 << 10) flushAck();
      else ackTimer ??= setTimeout(flushAck, 5);
    };

    // Created once the font is in, since xterm measures it only once, and a frame later:
    // StrictMode's mount/unmount/mount shouldn't start xterm's timers on a terminal that is
    // disposed straight away.
    let frame = 0;
    void terminalFont.then(() => {
      if (disposed) return;
      frame = requestAnimationFrame(() => {
        if (disposed) return;
        const term = new XTerm({
          cursorBlink: true,
          // Same text setup as kiwi-code: the bundled variable JetBrains Mono, with Nerd Font
          // symbols as a fallback, drawn by the canvas renderer.
          fontFamily: FONT_FAMILY,
          fontSize: 13,
          fontWeight: "400",
          fontWeightBold: 650,
          letterSpacing: 0,
          lineHeight: 1.28,
          macOptionIsMeta: true,
          // Keep explicit colours (e.g. RGB black) readable on the background.
          minimumContrastRatio: 4.5,
          overviewRulerWidth: 0,
          rightClickSelectsWord: true,
          // tmux keeps the history.
          scrollback: 1000,
          theme: THEMES[resolvedTheme()],
        });
        cleanups.push(onThemeChange(() => (term.options.theme = THEMES[resolvedTheme()])));
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.loadAddon(new WebLinksAddon());
        term.open(el);
        term.loadAddon(new CanvasAddon());
        view.current = { term, fit };
        cleanups.push(() => {
          view.current = null;
          term.dispose();
        });

        // Copying in tmux (mouse selection, copy mode) arrives as OSC 52.
        term.parser.registerOscHandler(52, (data) => {
          const b64 = data.slice(data.indexOf(";") + 1);
          if (b64 && b64 !== "?") {
            try {
              copyText(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
            } catch {
              /* not base64 */
            }
          }
          return true;
        });
        term.attachCustomKeyEventHandler((e) => {
          if (e.type !== "keydown") return true;
          const mod = e.ctrlKey || e.metaKey;
          const key = e.key.toLowerCase();
          // Ctrl+C copies when there is a selection, and is ^C otherwise.
          if (mod && key === "c" && term.hasSelection()) {
            copyText(term.getSelection());
            term.clearSelection();
            return false;
          }
          // Let the browser's paste event reach xterm instead of sending ^V.
          if ((mod && key === "v") || (e.shiftKey && key === "insert")) return false;
          return true;
        });

        term.onData((d) => send(encoder.encode(d)));
        term.onBinary((d) => send(Uint8Array.from(d, (c) => c.charCodeAt(0))));
        term.onResize(({ cols, rows }) => send(JSON.stringify({ type: "resize", cols, rows })));
        const refit = () => {
          if (el.clientWidth > 0 && el.clientHeight > 0) fit.fit();
        };
        const ro = new ResizeObserver(() => requestAnimationFrame(() => !disposed && refit()));
        ro.observe(el);
        cleanups.push(() => ro.disconnect());
        document.fonts?.ready.then(() => !disposed && refit());

        const connect = () => {
          refit();
          setConn({ state: "connecting" });
          const sock = new WebSocket(terminalWsUrl(task.host_id, task.id, term.cols, term.rows, toolId));
          sock.binaryType = "arraybuffer";
          ws = sock;
          let stable: ReturnType<typeof setTimeout> | undefined;
          sock.onopen = () => {
            stable = setTimeout(() => (retries = 0), 5000);
            send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
          };
          sock.onmessage = (e) => {
            if (typeof e.data === "string") {
              try {
                if (JSON.parse(e.data).type === "ready") {
                  setConn({ state: "open" });
                  term.focus();
                }
              } catch {
                /* not for us */
              }
              return;
            }
            const bytes = new Uint8Array(e.data as ArrayBuffer);
            term.write(bytes, () => ack(bytes.length));
          };
          sock.onclose = (e) => {
            clearTimeout(stable);
            if (disposed || ws !== sock) return;
            ws = null;
            unacked = 0;
            if (e.code === 1000) return setConn({ state: "ended" });
            if (e.code === 1011 || retries >= 6) return setConn({ state: "error", message: e.reason || "Can't reach the terminal" });
            // Dropped (network, server restart): tmux repaints the screen when we re-attach.
            retries++;
            setConn({ state: "connecting" });
            retryTimer = setTimeout(() => {
              term.reset();
              connect();
            }, Math.min(250 * 2 ** retries, 2000));
          };
        };
        connect();
      });
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      clearTimeout(retryTimer);
      clearTimeout(ackTimer);
      ws?.close();
      cleanups.forEach((f) => f());
    };
  }, [available, task.host_id, task.id, toolId, attempt]);

  // Coming back to the tab: the size may have changed while it was hidden.
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      const v = view.current;
      if (!v || !box.current?.clientWidth) return;
      v.fit.fit();
      v.term.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, conn.state]);

  const restart = async () => {
    await api.killTerminal(task.host_id, task.id, toolId).catch(() => {});
    setAttempt((n) => n + 1);
  };

  if (status && !status.available)
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-[13px] text-muted">
        Terminal unavailable: {status.reason ?? "unknown reason"}
      </div>
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3 text-[12px]">
        {tool ? <SquareTerminal size={13} className="text-faint" /> : <TerminalSquare size={13} className="text-faint" />}
        {tool && (
          <span className="shrink-0 font-mono text-muted" title={tool.command}>
            {tool.command}
          </span>
        )}
        <span className="min-w-0 truncate font-mono text-faint" title={status?.cwd ?? undefined}>
          {tool && status?.cwd ? "in " : ""}
          {status?.cwd ?? ""}
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-faint">
          {conn.state === "connecting" && (
            <>
              <Loader2 size={12} className="animate-spin" /> Connecting…
            </>
          )}
          {conn.state === "open" && "tmux"}
        </span>
        <Button size="sm" variant="ghost" onClick={restart} title={tool ? `End ${tool.name} and start it again` : "End the session and start a new shell"}>
          <RotateCcw size={12} /> Restart
        </Button>
        {onClose ? (
          <Button size="sm" variant="ghost" onClick={onClose} title={`End ${tool?.name ?? "the session"} and close it`}>
            <X size={12} /> Close
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={conn.state !== "open"}
            onClick={() => api.killTerminal(task.host_id, task.id, toolId).catch(() => {})}
            title="End the tmux session"
          >
            <Square size={11} /> End
          </Button>
        )}
      </div>
      <div className="relative min-h-0 flex-1 bg-bg">
        <div ref={box} className="absolute inset-0 py-1 pl-2" />
        {(conn.state === "ended" || conn.state === "error") && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-bg/85 text-[13px] text-muted">
            <div>{conn.state === "ended" ? (tool ? `${tool.name} exited.` : "Session ended.") : `Terminal disconnected: ${conn.message}`}</div>
            <div className="flex gap-2">
              <Button size="sm" variant="primary" onClick={() => setAttempt((n) => n + 1)}>
                {conn.state !== "ended" ? "Reconnect" : tool ? `Start ${tool.name} again` : "Start a new session"}
              </Button>
              {onClose && conn.state === "ended" && (
                <Button size="sm" variant="ghost" onClick={onClose}>
                  Close
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
