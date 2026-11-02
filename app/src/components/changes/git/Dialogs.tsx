// The bar at the bottom of the Changes tab, and its dialogs: confirmations, lazygit's menus, a commit message, the help.
import clsx from "clsx";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, Input, isSubmitShortcut, Kbd, Modal, SUBMIT_KEYS, Textarea } from "../../ui";
import { errText, noop, type Dialog, type MenuEntry, type Option } from "./model";

/** The bar at the bottom: what can be done where you are (each one clickable), and what's going on. */
export function OptionsBar({ options, busy, flash, onDismiss }: { options: Option[]; busy: string | null; flash: { text: string; error?: boolean } | null; onDismiss: () => void }) {
  return (
    <div className="flex h-7 shrink-0 items-center gap-3 overflow-hidden border-t border-line px-2 text-[11.5px]">
      <div className="flex min-w-0 flex-1 items-center gap-x-3 overflow-hidden whitespace-nowrap">
        {options
          .filter((o) => o.run !== noop)
          .map((o) => (
            <button key={o.key + o.label} tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={o.run} className="shrink-0 text-muted hover:text-fg">
              <span className="text-accent">{o.label}</span>: {o.key}
            </button>
          ))}
        <span className="shrink-0 text-faint">Keybindings: ?</span>
      </div>
      {busy ? (
        <span className="flex shrink-0 items-center gap-1.5 text-muted">
          <Loader2 size={11} className="animate-spin" /> {busy}…
        </span>
      ) : flash ? (
        <button
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onDismiss}
          title="Dismiss"
          className={clsx("max-w-[55%] shrink-0 truncate text-left", flash.error ? "text-red-400" : "text-emerald-400")}
        >
          {flash.text}
        </button>
      ) : null}
    </div>
  );
}

export function DialogView({ dialog, options, onClose }: { dialog: Dialog; options: { title: string; items: Option[] }[]; onClose: () => void }) {
  if (dialog.kind === "help") return <HelpDialog options={options} onClose={onClose} />;
  if (dialog.kind === "menu") return <MenuDialog title={dialog.title} items={dialog.items} onClose={onClose} />;
  if (dialog.kind === "confirm")
    return (
      <Modal
        title={dialog.title}
        onClose={onClose}
        onSubmit={() => {
          onClose();
          dialog.onYes();
        }}
      >
        <div className="text-[13px] text-muted">{dialog.body}</div>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            autoFocus
            variant={dialog.danger ? "danger" : "primary"}
            onClick={() => {
              onClose();
              dialog.onYes();
            }}
          >
            {dialog.yes}
          </Button>
        </div>
      </Modal>
    );
  if (dialog.kind === "input") return <InputDialog dialog={dialog} onClose={onClose} />;
  return <MessageDialog dialog={dialog} onClose={onClose} />;
}

function InputDialog({ dialog, onClose }: { dialog: Extract<Dialog, { kind: "input" }>; onClose: () => void }) {
  const [text, setText] = useState("");
  const submit = () => {
    onClose();
    dialog.submit(text.trim());
  };
  return (
    <Modal title={dialog.title} onClose={onClose} onSubmit={submit}>
      <Input autoFocus value={text} placeholder={dialog.placeholder} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={submit}>
          {dialog.yes}
        </Button>
      </div>
    </Modal>
  );
}

/** A commit message: a summary line (Enter commits) and a description. */
function MessageDialog({ dialog, onClose }: { dialog: Extract<Dialog, { kind: "message" }>; onClose: () => void }) {
  const [summary, setSummary] = useState(dialog.summary);
  const [body, setBody] = useState(dialog.body);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const message = body.trim() ? `${summary.trim()}\n\n${body.trim()}` : summary.trim();
  const { onDraft } = dialog;
  useEffect(() => {
    onDraft?.(message);
  }, [onDraft, message]);
  const submit = async () => {
    if (!summary.trim() || saving) return;
    setSaving(true);
    setErr(null);
    try {
      await dialog.submit(message);
      onClose();
    } catch (e) {
      setErr(errText(e));
      setSaving(false);
    }
  };
  return (
    <Modal title={dialog.title} onClose={onClose} onSubmit={() => void submit()} width="max-w-xl">
      <div className="space-y-2" data-draft={summary || body ? "" : undefined}>
        <Input
          autoFocus
          value={summary}
          placeholder="Summary"
          onChange={(e) => setSummary(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !isSubmitShortcut(e) && void submit()}
          className="font-mono"
        />
        <Textarea value={body} placeholder="Description (optional)" rows={6} onChange={(e) => setBody(e.target.value)} className="font-mono text-[12.5px]" />
      </div>
      {err && <div className="mt-2 max-h-40 overflow-auto font-mono text-[11.5px] whitespace-pre-wrap text-red-400">{err}</div>}
      <div className="mt-4 flex items-center justify-end gap-2">
        <span className="mr-auto text-[11.5px] text-faint">
          Enter in the summary or {SUBMIT_KEYS} to {dialog.yes.toLowerCase()}
        </span>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!summary.trim() || saving} onClick={() => void submit()}>
          {saving && <Loader2 size={12} className="animate-spin" />} {dialog.yes}
        </Button>
      </div>
    </Modal>
  );
}

/** lazygit's menus: an item's key picks it, or move to it and press Enter. */
function MenuDialog({ title, items, onClose }: { title: string; items: MenuEntry[]; onClose: () => void }) {
  const [at, setAt] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const choose = (m: MenuEntry) => {
    onClose();
    m.run();
  };
  return (
    <Modal title={title} onClose={onClose}>
      <div
        ref={ref}
        tabIndex={-1}
        className="outline-none"
        onKeyDown={(e) => {
          const m = items.find((x) => x.key === e.key);
          if (m) choose(m);
          else if (e.key === "ArrowDown" || e.key === "j") setAt((at + 1) % items.length);
          else if (e.key === "ArrowUp" || e.key === "k") setAt((at + items.length - 1) % items.length);
          else if (e.key === "Enter" || e.key === " ") choose(items[at]);
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {items.map((m, i) => (
          <button
            key={m.key}
            tabIndex={-1}
            onMouseEnter={() => setAt(i)}
            onClick={() => choose(m)}
            className={clsx("flex w-full items-baseline gap-3 rounded-md px-2.5 py-1.5 text-left", i === at && "bg-white/[0.07]")}
          >
            <Kbd>{m.key}</Kbd>
            <span className={clsx("text-[13px]", m.danger ? "text-red-300" : "text-fg")}>{m.label}</span>
            {m.hint && <span className="ml-auto text-[11.5px] text-faint">{m.hint}</span>}
          </button>
        ))}
      </div>
    </Modal>
  );
}

function HelpDialog({ options, onClose }: { options: { title: string; items: Option[] }[]; onClose: () => void }) {
  return (
    <Modal title="Keybindings" onClose={onClose} width="max-w-2xl">
      <div className="max-h-[65vh] space-y-4 overflow-y-auto">
        {[...options, ...HELP].map((g) => (
          <div key={g.title}>
            <div className="mb-1 text-[11px] font-semibold tracking-wide text-faint uppercase">{g.title}</div>
            <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-[12.5px]">
              {g.items.map((o) => (
                <div key={o.key + o.label} className="contents">
                  <span className="font-mono text-accent">{o.key}</span>
                  <span className="text-muted">{o.label}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

/** The rest, for the help: what's not where you are now. */
const HELP: { title: string; items: Option[] }[] = [
  {
    title: "Staging lines (Enter on a file)",
    items: [
      ["↑/↓ j/k", "Move between changed lines"],
      ["shift+↑/↓ J/K", "Select a range"],
      ["←/→ h/l", "Previous / next hunk"],
      ["space", "Stage (or, in the staged changes, unstage) the lines"],
      ["v", "Start or end a range"],
      ["a", "Select whole hunks"],
      ["d", "Discard the lines"],
      ["tab", "Switch between unstaged and staged changes"],
      ["click, shift+click, drag", "Put the cursor on a line, select a range"],
      ["esc", "Back to the files"],
    ].map(([key, label]) => ({ key, label, run: noop })),
  },
  {
    title: "Comments for the agent",
    items: [
      ["n", "Comment on the line under the cursor, or the lines picked (in a commit's or the branch's diff, pick lines by their numbers)"],
      ["hover a line", "Its comment button"],
      ["Enter / Shift+Enter", "In a comment: add it / a new line"],
      ["|", "Unified or split diffs"],
    ].map(([key, label]) => ({ key, label, run: noop })),
  },
  {
    title: "Lists",
    items: [
      ["↑/↓ j/k", "Move"],
      [", .  PgUp/PgDn", "A page up or down"],
      ["< >  Home/End", "First, last"],
      ["←/→ h/l, 1-4", "Panels"],
      ["right-click", "A menu for the file, commit or stash"],
    ].map(([key, label]) => ({ key, label, run: noop })),
  },
];
