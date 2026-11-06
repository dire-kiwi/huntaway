import clsx from "clsx";
import { ArrowLeft, ArrowRight, Bug, ExternalLink, Globe, RotateCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Task } from "../../api";
import { IconButton } from "../ui";
import { browserUrl } from "./browserUrl";

/** The desktop app's <webview> (Electron's WebviewTag), as much of it as the pane uses. */
interface WebviewElement extends HTMLWebViewElement {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  reload(): void;
  stop(): void;
  openDevTools(): void;
}

// React has no `allowpopups` (its types say boolean, and it drops `true` for an attribute it doesn't know): Electron
// looks for the attribute, whatever its value. Popups open in the pane (electron/main.cjs).
const ALLOW_POPUPS = { allowpopups: "true" } as object;

/** Whether this board can show a browser pane: in the desktop app since it can (HA-275). A browser's frames hold only the board's own pages. */
export const canBrowse = () => !!window.huntawayDesktop?.browserPane;

/** The pages' own session (electron/main.cjs gives every pane it, whatever the page asks): their cookies and storage stay out of the board's. */
const PARTITION = "persist:huntaway-browser";

const urlKey = (task: Task) => `ia.browser:${task.host_id}:${task.id}`;

/**
 * A browser beside the task's thread, as in the desktop app (HA-275): an address bar, back, forward, reload, the page's
 * DevTools, and opening it in the system's browser. Each task keeps the page it was last on, or opens on its preview.
 */
export function BrowserPane({ task, onClose }: { task: Task; onClose: () => void }) {
  const key = urlKey(task);
  const [start] = useState(() => localStorage.getItem(key) || task.preview_url || "");
  // What the webview was first given: later pages are loaded into it, so that it isn't made again.
  const [src, setSrc] = useState(start);
  const [url, setUrl] = useState(start);
  const [input, setInput] = useState(start);
  const [loading, setLoading] = useState(false);
  const [nav, setNav] = useState({ back: false, forward: false });
  const [error, setError] = useState<string | null>(null);
  const [bad, setBad] = useState(false);
  const [title, setTitle] = useState("");
  const ref = useRef<WebviewElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editing = useRef(false);

  useEffect(() => {
    if (!start) inputRef.current?.focus();
  }, [start]);

  useEffect(() => {
    const wv = ref.current;
    if (!wv) return;
    const navState = () => {
      try {
        setNav({ back: wv.canGoBack(), forward: wv.canGoForward() });
      } catch {
        /* not attached yet */
      }
    };
    const went = (e: Event) => {
      const { url: to, isMainFrame } = e as Event & { url: string; isMainFrame?: boolean };
      if (isMainFrame === false) return;
      setUrl(to);
      if (!editing.current) setInput(to);
      localStorage.setItem(key, to);
      navState();
    };
    const on: Record<string, (e: Event) => void> = {
      "did-start-loading": () => {
        setLoading(true);
        setError(null);
      },
      "did-stop-loading": () => {
        setLoading(false);
        navState();
      },
      "did-navigate": went,
      "did-navigate-in-page": went,
      "did-fail-load": (e) => {
        const { errorCode, errorDescription, validatedURL, isMainFrame } = e as Event & {
          errorCode: number;
          errorDescription: string;
          validatedURL: string;
          isMainFrame: boolean;
        };
        // -3 is ERR_ABORTED: a navigation that another replaced.
        if (isMainFrame && errorCode !== -3) setError(`Couldn't load ${validatedURL}: ${errorDescription || `error ${errorCode}`}`);
      },
      "page-title-updated": (e) => setTitle((e as Event & { title: string }).title),
      "dom-ready": navState,
    };
    for (const [type, f] of Object.entries(on)) wv.addEventListener(type, f);
    return () => {
      for (const [type, f] of Object.entries(on)) wv.removeEventListener(type, f);
    };
  }, [src, key]);

  const go = (to: string) => {
    setError(null);
    setUrl(to);
    setInput(to);
    if (!src) setSrc(to);
    else ref.current?.loadURL(to).catch(() => {}); // a failure comes as did-fail-load
  };

  const submit = () => {
    const to = browserUrl(input);
    setBad(!to);
    if (!to) return;
    inputRef.current?.blur();
    go(to);
  };

  return (
    <div className="flex h-full min-w-0 flex-col bg-bg">
      <div className="flex h-10 shrink-0 items-center gap-0.5 border-b border-line px-1.5">
        <IconButton title="Back" disabled={!nav.back} onClick={() => ref.current?.goBack()}>
          <ArrowLeft size={14} />
        </IconButton>
        <IconButton title="Forward" disabled={!nav.forward} onClick={() => ref.current?.goForward()}>
          <ArrowRight size={14} />
        </IconButton>
        <IconButton
          title={loading ? "Stop loading" : "Reload"}
          disabled={!src}
          onClick={() => (loading ? ref.current?.stop() : error && url ? go(url) : ref.current?.reload())}
        >
          {loading ? <X size={14} /> : <RotateCw size={13} />}
        </IconButton>
        <form
          className="mx-1 min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setBad(false);
            }}
            onFocus={(e) => {
              editing.current = true;
              e.target.select();
            }}
            onBlur={() => (editing.current = false)}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              // Back to the page's address, and out of the field.
              e.preventDefault();
              setInput(url);
              setBad(false);
              e.currentTarget.blur();
            }}
            spellCheck={false}
            placeholder="Address, or a port on localhost"
            title={bad ? "Not a web address: only http: and https: pages open here" : title || undefined}
            aria-invalid={bad}
            className={clsx(
              "h-7 w-full rounded-md border bg-panel px-2.5 font-mono text-[12px] text-fg outline-none placeholder:font-sans placeholder:text-faint",
              bad ? "border-red-500/70" : "border-line focus:border-accent/60",
            )}
          />
        </form>
        <IconButton title="The page's DevTools" disabled={!src} onClick={() => ref.current?.openDevTools()}>
          <Bug size={14} />
        </IconButton>
        {/* The desktop app opens a new window's web address in the system's browser. */}
        <IconButton title="Open in your browser" disabled={!url} onClick={() => window.open(url, "_blank", "noopener")}>
          <ExternalLink size={13} />
        </IconButton>
        <IconButton title="Close the browser" onClick={onClose}>
          <X size={15} />
        </IconButton>
      </div>
      <div className="relative min-h-0 flex-1">
        {src ? (
          <webview
            ref={ref}
            src={src}
            partition={PARTITION}
            {...ALLOW_POPUPS}
            className={clsx("absolute inset-0 h-full w-full bg-white", error && "invisible")}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-[13px] text-muted">
            <Globe size={22} className="text-faint" />
            <p>
              Type an address above: a port like <span className="font-mono text-fg">5173</span> opens localhost.
            </p>
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-[13px] text-muted">
            <p className="max-w-md break-words text-red-400">{error}</p>
            {src && url && (
              <button className="rounded-md border border-line px-3 py-1 text-fg hover:bg-white/5" onClick={() => go(url)}>
                Retry
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const SHARE_KEY = "ia.browserShare";
const clampShare = (n: number) => Math.min(0.8, Math.max(0.2, n));

/**
 * How much of the task's width the browser pane takes beside the thread (half at first, kept for every task), and the
 * bar between them that's dragged to change it. While it's dragged a cover over the window keeps the pointer's moves
 * from the page in the pane, which would otherwise take them.
 */
export function useBrowserShare() {
  const [share, setShare] = useState(() => clampShare(Number(localStorage.getItem(SHARE_KEY)) || 0.5));
  const [dragging, setDragging] = useState(false);
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!dragging) return;
    const box = bar.current?.parentElement?.getBoundingClientRect();
    if (!box) return;
    let last = share;
    const move = (e: PointerEvent) => setShare((last = clampShare((box.right - e.clientX) / box.width)));
    const up = () => {
      setDragging(false);
      localStorage.setItem(SHARE_KEY, String(last));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    // Measured once a drag starts: `share` only moves during it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging]);
  const splitter = (
    <div
      ref={bar}
      role="separator"
      aria-orientation="vertical"
      title="Drag to resize the browser"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDoubleClick={() => {
        setShare(0.5);
        localStorage.setItem(SHARE_KEY, "0.5");
      }}
      className={clsx("w-1 shrink-0 cursor-col-resize border-l border-line hover:bg-accent/40", dragging && "bg-accent/40")}
    >
      {dragging && <div className="fixed inset-0 z-50 cursor-col-resize" />}
    </div>
  );
  return [share, splitter] as const;
}
