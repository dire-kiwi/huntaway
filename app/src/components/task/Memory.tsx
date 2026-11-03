// The assistant's Memory tab (API 99): its USER.md, MEMORY.md and daily logs, which the board loads into each of its runs
// (see server/src/agent/assistant/memory.rs). Edit them, see each file's history and restore a version, or import what
// another assistant knows about you.
import clsx from "clsx";
import { Copy, FileText, History, Import, Loader2, RotateCcw, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type MemoryCommit, type MemoryFile, type MemoryOverview, type Task } from "../../api";
import { Button, copyText, Modal, ModalFooter, Textarea, timeAgo } from "../ui";

/** An edit not saved yet, kept by host, task and path while the tab is closed or another file is open. `base`: what the
 *  editor opened (null for a file that wasn't there), which the save checks is still what's there. */
interface Draft {
  content: string;
  base: string | null;
}
const drafts = new Map<string, Draft>();
const draftKey = (task: Task, path: string) => `${task.host_id}:${task.id}:${path}`;

// Each file's save on its way, and one refused because the assistant changed the file, by the same key: kept here rather
// than in the editor, which goes when another file or tab is opened, so the editor shown when the save ends (a new one, if
// the file was opened again) is told, and takes it in without losing what was typed meanwhile (see `saved`).
const saving = new Set<string>();
const conflicts = new Set<string>();
const editors = new Map<string, Set<(saved?: string) => void>>();
/** Tell the file's editors that its save state changed, and with `saved`, what the save wrote. */
const tell = (key: string, saved?: string) => editors.get(key)?.forEach((f) => f(saved));

/** A save of `key` wrote `content`: the draft, if more was typed since, is now an edit of that. */
function saved(key: string, content: string) {
  const d = drafts.get(key);
  if (!d || d.content === content) drafts.delete(key);
  else drafts.set(key, { content: d.content, base: content });
}

const n = (x: number) => x.toLocaleString("en");

/** Files a run is told: USER.md and MEMORY.md, and today's and yesterday's logs. */
const LOADED = new Set(["user", "memory"]);

const TITLES: Record<MemoryFile["kind"], string> = { user: "About you", memory: "Memory", log: "Daily logs", other: "Other files" };

export function MemoryView({ task, onShowThread }: { task: Task; onShowThread: () => void }) {
  const [overview, setOverview] = useState<MemoryOverview>();
  const [error, setError] = useState<string>();
  const [path, setPath] = useState("USER.md");
  const [importing, setImporting] = useState(false);
  const host = task.host_id;
  const profile = task.profile_id;

  const load = useCallback(() => {
    api
      .memory(host, profile)
      .then((o) => {
        setOverview(o);
        setError(undefined);
      })
      .catch((e: Error) => setError(e.message));
  }, [host, profile]);
  // Again whenever a turn ends, as the assistant may have changed its files.
  useEffect(load, [load, task.running]);

  // Today's log is listed before it's written, to start it.
  const files = useMemo(() => {
    const list = overview?.files ?? [];
    if (!overview || list.some((f) => f.path === overview.today)) return list;
    const today: MemoryFile = { path: overview.today, kind: "log", size: 0, chars: null, modified: null };
    const at = list.findIndex((f) => f.kind === "other");
    return at < 0 ? [...list, today] : [...list.slice(0, at), today, ...list.slice(at)];
  }, [overview]);
  const file = files.find((f) => f.path === path);

  if (!overview)
    return (
      <div className="p-8 text-[13px] text-muted">
        {error ? `Couldn't open the assistant's memory: ${error}` : <Loader2 size={14} className="animate-spin" />}
      </div>
    );

  const loadedLogs = new Set([overview.today, yesterday(overview.today)]);
  const groups = (["user", "memory", "log", "other"] as const).map((k) => ({ kind: k, files: files.filter((f) => f.kind === k) })).filter((g) => g.files.length);

  return (
    <div className="flex h-full min-h-0 narrow:flex-col">
      <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-panel/40 narrow:max-h-[35%] narrow:w-full narrow:border-r-0 narrow:border-b">
        <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
          <span className="text-xs font-medium text-muted">Memory</span>
          <Button size="sm" variant="ghost" onClick={() => setImporting(true)} title="Bring in what another assistant knows about you">
            <Import size={13} /> Import
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {groups.map((g) => (
            <div key={g.kind} className="py-1">
              <div className="px-3 py-1 text-[11px] font-medium tracking-wide text-faint uppercase">{TITLES[g.kind]}</div>
              {g.files.map((f) => {
                const loaded = LOADED.has(f.kind) || loadedLogs.has(f.path);
                const over = loaded && ((f.chars ?? 0) > overview.cap || (overview.cap_bytes !== undefined && f.size > overview.cap_bytes));
                return (
                  <button
                    key={f.path}
                    onClick={() => setPath(f.path)}
                    className={clsx("flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px]", f.path === path ? "bg-raised text-fg" : "text-muted hover:text-fg")}
                    title={loaded ? "Loaded into each of the assistant's runs" : "Not loaded: the assistant reads it when it needs it"}
                  >
                    <FileText size={13} className={clsx("shrink-0", loaded ? "text-accent" : "text-faint")} />
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{f.kind === "log" ? f.path.slice("memory/".length) : f.path}</span>
                    {drafts.has(draftKey(task, f.path)) && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" title="Not saved" />}
                    {f.chars === null && f.modified === null ? (
                      <span className="text-[11px] text-faint">new</span>
                    ) : loaded && f.chars !== null ? (
                      <span className={clsx("text-[11px] tabular-nums", over ? "text-amber-300" : "text-faint")}>{n(f.chars)}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <p className="border-t border-line px-3 py-2 text-[11px] leading-snug text-faint narrow:hidden">
          Highlighted files go into every run, up to {n(overview.cap)} characters
          {overview.cap_bytes !== undefined && ` (${n(Math.floor(overview.cap_bytes / 1024))} KB)`} each. The assistant keeps them up to date; you can edit them too.
        </p>
      </aside>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <FileEditor
          key={`${task.id}:${path}`}
          task={task}
          path={path}
          file={file}
          cap={LOADED.has(file?.kind ?? "other") || loadedLogs.has(path) ? overview.cap : undefined}
          capBytes={overview.cap_bytes}
          history={overview.history}
          onSaved={load}
        />
      </section>
      {importing && (
        <ImportDialog
          prompt={overview.import_prompt}
          onClose={() => setImporting(false)}
          onSend={async (text) => {
            await api.importMemory(host, profile, text);
            setImporting(false);
            onShowThread();
          }}
        />
      )}
    </div>
  );
}

/** The day before `memory/YYYY-MM-DD.md`, as a log's path. */
function yesterday(today: string) {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(today);
  if (!m) return "";
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] - 1));
  return `memory/${d.toISOString().slice(0, 10)}.md`;
}

function FileEditor({
  task,
  path,
  file,
  cap,
  capBytes,
  history,
  onSaved,
}: {
  task: Task;
  path: string;
  file: MemoryFile | undefined;
  /** How much of it a run is told, if it's loaded. */
  cap?: number;
  /** And in bytes, if the host says. */
  capBytes?: number;
  history: boolean;
  onSaved: () => void;
}) {
  const key = draftKey(task, path);
  const [base, setBase] = useState<string | null>();
  const [content, setContent] = useState(() => drafts.get(key)?.content ?? "");
  const [error, setError] = useState<string>();
  // Whether it's being saved, or a save was refused (see `saving`), re-read when the file's editors are told.
  const [, changed] = useState(0);
  const busy = saving.has(key);
  const conflict = conflicts.has(key);
  const [showHistory, setShowHistory] = useState(false);
  const [viewing, setViewing] = useState<MemoryCommit>();
  const exists = !!file?.modified;

  // What's there now. A draft keeps its own base, so a save still checks against what it was written over.
  const fetchFile = useCallback(
    () => (exists ? api.memoryFile(task.host_id, task.profile_id, path).then((f) => f.content) : Promise.resolve(null)),
    [exists, task.host_id, task.profile_id, path],
  );
  useEffect(() => {
    let live = true;
    const draft = drafts.get(key);
    if (draft) {
      setBase(draft.base);
      setContent(draft.content);
      return;
    }
    fetchFile()
      .then((c) => {
        if (!live || drafts.has(key)) return;
        setBase(c);
        setContent(c ?? "");
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
    // Again when the assistant changes it (its modified time), unless there's a draft.
  }, [key, fetchFile, file?.modified]);

  // A save that ends, whichever editor of the file started it: what it wrote is the new base, and the draft (what was
  // typed since, in this editor or one before it) stays on top of it.
  useEffect(() => {
    const listen = (written?: string) => {
      if (written !== undefined) {
        setBase(written);
        setContent(drafts.get(key)?.content ?? written);
      }
      changed((n) => n + 1);
    };
    const set = editors.get(key) ?? new Set();
    editors.set(key, set.add(listen));
    return () => void set.delete(listen);
  }, [key]);

  const dirty = base !== undefined && content !== (base ?? "");
  const edit = (c: string) => {
    setContent(c);
    if (base === undefined) return;
    // While a save is on its way, even a change back to what was there is kept, as it isn't what's being saved.
    if (c === (base ?? "") && !saving.has(key)) drafts.delete(key);
    else drafts.set(key, { content: c, base });
  };

  const save = async (force = false) => {
    // Nothing to save (Ctrl+S on a file as it is, or a log not written yet, which would make it empty).
    if (base === undefined || saving.has(key) || (!dirty && !force)) return;
    saving.add(key);
    conflicts.delete(key);
    tell(key);
    setError(undefined);
    let written: string | undefined;
    try {
      written = (await api.writeMemoryFile(task.host_id, task.profile_id, path, content, base, force)).content;
      saved(key, written);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) conflicts.add(key);
      else setError((e as Error).message);
    } finally {
      saving.delete(key);
      tell(key, written);
    }
    if (written !== undefined) onSaved();
  };
  const discard = async () => {
    drafts.delete(key);
    conflicts.delete(key);
    tell(key);
    setError(undefined);
    try {
      const c = await fetchFile().catch(() => null);
      setBase(c);
      setContent(c ?? "");
    } finally {
      onSaved();
    }
  };

  // Ctrl+S saves wherever the focus is in the tab (rather than saving the page).
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (viewing) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s" && !document.querySelector("[data-modal]")) {
        e.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewing]);

  const chars = [...content].length;
  // Past the cap in bytes (as text in a script of 3 or 4 bytes a character can be) before the one in characters.
  const bytes = capBytes !== undefined && content.length > capBytes / 4 ? new TextEncoder().encode(content).length : 0;
  const over = cap !== undefined && (chars > cap || (capBytes !== undefined && bytes > capBytes));
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        <span className="font-mono text-[13px] text-fg">{path}</span>
        {cap !== undefined && (
          <span className={clsx("text-[11px] tabular-nums", over ? "text-amber-300" : "text-faint")} title="How much of it the assistant is told at the start of each run">
            {n(chars)} / {n(cap)} characters{chars <= cap && over && ` (over ${n(Math.floor(capBytes! / 1024))} KB)`}
            {over && (path.startsWith("memory/") ? ": only the end is loaded" : ": the rest isn't loaded")}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {history && exists && (
            <Button size="sm" variant={showHistory ? "secondary" : "ghost"} onClick={() => (setShowHistory(!showHistory), setViewing(undefined))}>
              <History size={13} /> History
            </Button>
          )}
          {dirty && !viewing && (
            <Button size="sm" variant="ghost" onClick={discard} title="Drop your changes">
              Revert
            </Button>
          )}
          {!viewing && (
            <Button size="sm" variant="primary" disabled={!dirty || busy} onClick={() => save()} title="Save (Ctrl+S)">
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Save
            </Button>
          )}
        </div>
      </div>
      {conflict && (
        <div className="flex flex-wrap items-center gap-2 border-b border-amber-500/25 bg-amber-500/10 px-4 py-2 text-[12.5px] text-amber-200">
          The assistant changed {path} since you opened it.
          <Button size="sm" onClick={discard}>
            Load its version
          </Button>
          <Button size="sm" variant="danger" onClick={() => save(true)}>
            Overwrite it with yours
          </Button>
        </div>
      )}
      {error && <div className="border-b border-line px-4 py-2 text-[12.5px] text-red-300">{error}</div>}
      <div className="flex min-h-0 flex-1 narrow:flex-col">
        {viewing ? (
          <CommitView
            task={task}
            path={path}
            commit={viewing}
            onBack={() => setViewing(undefined)}
            onRestored={(c) => {
              drafts.delete(key);
              setBase(c);
              setContent(c);
              setViewing(undefined);
              onSaved();
            }}
            dirty={dirty}
          />
        ) : (
          <textarea
            aria-label={`Edit ${path}`}
            value={content}
            disabled={base === undefined}
            spellCheck={false}
            onChange={(e) => edit(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                e.preventDefault();
                save();
              }
            }}
            placeholder={exists ? "" : `${path} isn't there yet: write it, then save.`}
            className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3 font-mono [font-variant-ligatures:none] text-[12.5px] leading-relaxed text-fg outline-none placeholder:text-faint"
          />
        )}
        {showHistory && <HistoryList task={task} path={path} viewing={viewing} onView={setViewing} refresh={file?.modified} />}
      </div>
    </div>
  );
}

function HistoryList({
  task,
  path,
  viewing,
  onView,
  refresh,
}: {
  task: Task;
  path: string;
  viewing: MemoryCommit | undefined;
  onView: (c: MemoryCommit) => void;
  refresh: unknown;
}) {
  const [commits, setCommits] = useState<MemoryCommit[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    api
      .memoryHistory(task.host_id, task.profile_id, path)
      .then((h) => live && setCommits(h.commits))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [task.host_id, task.profile_id, path, refresh]);
  return (
    <div className="w-72 shrink-0 overflow-y-auto border-l border-line narrow:max-h-[40%] narrow:w-full narrow:border-l-0 narrow:border-t">
      {error && <div className="p-3 text-[12px] text-red-300">{error}</div>}
      {!commits && !error && <Loader2 size={14} className="m-3 animate-spin text-muted" />}
      {commits?.length === 0 && <div className="p-3 text-[12px] text-muted">No history yet.</div>}
      {commits?.map((c, i) => (
        <button
          key={c.sha}
          onClick={() => onView(c)}
          className={clsx("block w-full border-b border-line/60 px-3 py-2 text-left", viewing?.sha === c.sha ? "bg-raised" : "hover:bg-white/5")}
        >
          <div className="truncate text-[12.5px] text-fg">{c.message}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-faint">
            <span className={c.author === "You" ? "text-accent" : undefined}>{c.author}</span>
            <span title={new Date(c.date).toLocaleString()}>{timeAgo(c.date)}</span>
            <span className="font-mono">{c.sha.slice(0, 7)}</span>
            {i === 0 && <span>(current)</span>}
          </div>
        </button>
      ))}
    </div>
  );
}

function CommitView({
  task,
  path,
  commit,
  dirty,
  onBack,
  onRestored,
}: {
  task: Task;
  path: string;
  commit: MemoryCommit;
  dirty: boolean;
  onBack: () => void;
  onRestored: (content: string) => void;
}) {
  const [diff, setDiff] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    setDiff(undefined);
    api
      .memoryDiff(task.host_id, task.profile_id, commit.sha, path)
      .then((d) => live && setDiff(d.diff))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [task.host_id, task.profile_id, commit.sha, path]);
  const restore = async () => {
    if (dirty && !confirm(`Restoring drops the changes you haven't saved to ${path}.`)) return;
    setBusy(true);
    try {
      const w = await api.restoreMemoryFile(task.host_id, task.profile_id, path, commit.sha);
      onRestored(w.content);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // The patch's own header lines (diff --git, index, ---/+++) say nothing the title doesn't.
  const lines = (diff ?? "").split("\n").filter((l) => !/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity|rename )/.test(l));
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2 text-[12.5px]">
        <span className="text-muted">
          {commit.message} · {commit.author}, {new Date(commit.date).toLocaleString()}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={onBack}>
            Back to editing
          </Button>
          <Button size="sm" onClick={restore} disabled={busy} title={`Put ${path} back as it was after this change`}>
            <RotateCcw size={13} /> Restore this version
          </Button>
        </div>
      </div>
      {error && <div className="px-4 py-2 text-[12.5px] text-red-300">{error}</div>}
      <pre className="min-h-0 flex-1 overflow-auto px-4 py-3 font-mono [font-variant-ligatures:none] text-[12px] leading-relaxed">
        {diff === undefined && !error ? (
          <Loader2 size={14} className="animate-spin text-muted" />
        ) : lines.join("").trim() === "" ? (
          <span className="text-muted">No changes to {path} in this commit.</span>
        ) : (
          lines.map((l, i) => (
            <div
              key={i}
              className={clsx(
                "whitespace-pre-wrap",
                l.startsWith("+") ? "bg-emerald-500/10 text-emerald-200" : l.startsWith("-") ? "bg-red-500/10 text-red-200" : l.startsWith("@@") ? "text-faint" : "text-muted",
              )}
            >
              {l || " "}
            </div>
          ))
        )}
      </pre>
    </div>
  );
}

function ImportDialog({ prompt, onClose, onSend }: { prompt: string; onClose: () => void; onSend: (text: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onSend(text);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title="Import memory from another assistant" onClose={onClose} onSubmit={send} width="max-w-2xl">
      <div className="space-y-4 text-[13px]">
        <div className="space-y-1.5">
          <div className="text-muted">
            1. Paste this into the assistant that knows you (ChatGPT, Claude.ai, Gemini…), in a chat where it can use its memory:
          </div>
          <div className="relative rounded-md border border-line bg-raised/50 p-3 pr-20 text-[12.5px] leading-relaxed text-fg">
            {prompt}
            <Button
              size="sm"
              className="absolute top-2 right-2"
              onClick={() => {
                copyText(prompt);
                setCopied(true);
              }}
            >
              <Copy size={12} /> {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
        <div className="space-y-1.5">
          <div className="text-muted">2. Paste its answer here. Your assistant folds it into USER.md and MEMORY.md, and tells you what it changed.</div>
          <Textarea aria-label="The other assistant's answer" rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder="Its answer…" />
        </div>
        <ModalFooter>
          {error && <div className="mb-2 text-[12.5px] text-red-300">{error}</div>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!text.trim() || busy} onClick={send}>
              {busy && <Loader2 size={13} className="animate-spin" />} Send to the assistant
            </Button>
          </div>
        </ModalFooter>
      </div>
    </Modal>
  );
}
