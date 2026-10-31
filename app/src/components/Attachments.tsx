import clsx from "clsx";
import { FileText, Loader2, Paperclip, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { createPortal } from "react-dom";
import { attachmentUrl, isImage, uploadAttachment, type AttachmentRef } from "../attachments";

interface Item {
  key: string;
  name: string;
  /** Set once it's uploaded. */
  ref?: AttachmentRef;
}

let seq = 0;

/**
 * Files being attached to a prompt: pasted, dropped or picked, and uploaded to the host right away.
 * `initial` are files already on the host (a saved draft's).
 */
export function useAttachmentDraft(hostId: string, enabled = true, initial?: AttachmentRef[]) {
  const [items, setItems] = useState<Item[]>(() => (enabled && initial ? initial.map((ref) => ({ key: `a${++seq}`, name: ref.name, ref })) : []));
  const [err, setErr] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const add = (files: File[]) => {
    if (!enabled || !files.length) return;
    setErr(null);
    for (const file of files) {
      const key = `a${++seq}`;
      setItems((cur) => [...cur, { key, name: file.name || "pasted file" }]);
      uploadAttachment(hostId, file).then(
        (ref) => setItems((cur) => cur.map((it) => (it.key === key ? { ...it, name: ref.name, ref } : it))),
        (e) => {
          setItems((cur) => cur.filter((it) => it.key !== key));
          setErr((e as Error).message);
        },
      );
    }
  };
  const drop = useCallback((refs: AttachmentRef[]) => setItems((cur) => cur.filter((it) => !refs.some((r) => r.id === it.ref?.id))), []);
  const hasFiles = (e: DragEvent) => enabled && e.dataTransfer.types.includes("Files");

  return {
    enabled,
    items,
    err,
    dragging,
    /** Uploaded files, in order. */
    files: items.flatMap((it) => (it.ref ? [it.ref] : [])),
    uploading: items.some((it) => !it.ref),
    add,
    remove: (key: string) => setItems((cur) => cur.filter((it) => it.key !== key)),
    /** Put back files that are already on the host (an unqueued message's). */
    restore: (refs: AttachmentRef[]) => setItems((cur) => [...cur, ...refs.map((ref) => ({ key: `a${++seq}`, name: ref.name, ref }))]),
    clear: () => (setItems([]), setErr(null)),
    /** Take off these files (sent with a message), leaving any added since. */
    drop,
    onPaste: (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData.files);
      if (!enabled || !files.length) return;
      // Text copied along with a picture of it (e.g. spreadsheet cells) still pastes as text.
      if (!e.clipboardData.types.includes("text/plain")) e.preventDefault();
      add(files);
    },
    /** Spread on the element that takes dropped files. */
    dropProps: {
      onDragOver: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDragging(true);
      },
      onDragLeave: (e: DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      },
      onDrop: (e: DragEvent) => {
        setDragging(false);
        if (!hasFiles(e)) return;
        e.preventDefault();
        add(Array.from(e.dataTransfer.files));
      },
    },
  };
}

export type AttachmentDraft = ReturnType<typeof useAttachmentDraft>;

/** Paperclip button that picks files to attach. */
export function AttachButton({ draft, label, className }: { draft: AttachmentDraft; label?: string; className?: string }) {
  const input = useRef<HTMLInputElement>(null);
  if (!draft.enabled) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => input.current?.click()}
        title="Attach files (or paste or drop them)"
        className={clsx(
          "flex h-7 items-center justify-center gap-1.5 rounded-md text-faint hover:bg-white/5 hover:text-fg",
          label ? "px-2 text-[12px]" : "w-7",
          className,
        )}
      >
        <Paperclip size={14} />
        {label}
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          draft.add(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
    </>
  );
}

/** The files attached so far, each removable. */
export function DraftAttachments({ draft, hostId, className }: { draft: AttachmentDraft; hostId: string; className?: string }) {
  if (!draft.items.length && !draft.err) return null;
  return (
    <div className={className}>
      {draft.items.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {draft.items.map((it) => (
            <div key={it.key} className="group relative">
              {it.ref ? <Thumb hostId={hostId} file={it.ref} /> : <Chip name={it.name} pending />}
              <button
                type="button"
                onClick={() => draft.remove(it.key)}
                title="Remove"
                aria-label={`Remove ${it.name}`}
                className="absolute -top-1.5 -right-1.5 flex h-4.5 w-4.5 items-center justify-center rounded-full border border-line-strong bg-panel-2 text-muted opacity-0 group-hover:opacity-100 hover:text-fg focus-visible:opacity-100 touch:opacity-100"
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
      )}
      {draft.err && <div className="mt-1 text-xs text-red-400">{draft.err}</div>}
    </div>
  );
}

/** Files attached to a sent message. */
export function AttachmentList({ hostId, files, className }: { hostId: string; files: AttachmentRef[]; className?: string }) {
  if (!files.length) return null;
  return (
    <div className={clsx("flex flex-wrap gap-2", className)}>
      {files.map((f) => (
        <Thumb key={f.path} hostId={hostId} file={f} />
      ))}
    </div>
  );
}

function Chip({ name, pending, url }: { name: string; pending?: boolean; url?: string }) {
  const body = (
    <>
      {pending ? <Loader2 size={13} className="shrink-0 animate-spin" /> : <FileText size={13} className="shrink-0" />}
      <span className="truncate">{name}</span>
    </>
  );
  const cls = "flex h-8 max-w-[220px] items-center gap-1.5 rounded-md border border-line bg-panel px-2 text-[12px] text-muted";
  return url ? (
    <a href={url} download={name} title={`Download ${name}`} className={clsx(cls, "hover:border-line-strong hover:text-fg")}>
      {body}
    </a>
  ) : (
    <div className={cls} title={name}>
      {body}
    </div>
  );
}

/** An image's thumbnail (opens full size), or a file's name (downloads it). */
function Thumb({ hostId, file }: { hostId: string; file: AttachmentRef }) {
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const { id, name, path } = file;
  useEffect(() => {
    let live = true;
    const { url, release } = attachmentUrl(hostId, { id, name, path });
    url.then(
      (u) => live && setUrl(u),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
      release();
    };
  }, [hostId, id, name, path]);
  if (!isImage(file.name) || failed) return <Chip name={failed ? `${file.name} (unavailable)` : file.name} url={url} />;
  return (
    <>
      <button
        type="button"
        onClick={() => url && setOpen(true)}
        title={file.name}
        className="block h-16 w-16 overflow-hidden rounded-md border border-line bg-panel hover:border-line-strong"
      >
        {url ? <img src={url} alt={file.name} className="h-full w-full object-cover" /> : <Loader2 size={13} className="m-auto animate-spin text-faint" />}
      </button>
      {open && url && <Lightbox url={url} name={file.name} onClose={() => setOpen(false)} />}
    </>
  );
}

/** An image at full size over everything else. */
function Lightbox({ url, name, onClose }: { url: string; name: string; onClose: () => void }) {
  useEffect(() => {
    // Ahead of (and instead of) a dialog's or the task view's own Escape.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-2 bg-black/80 p-6"
      onMouseDown={(e) => (e.stopPropagation(), onClose())}
    >
      <img src={url} alt={name} className="max-h-[90vh] max-w-[90vw] rounded-md object-contain shadow-2xl" />
      <a href={url} download={name} onMouseDown={(e) => e.stopPropagation()} className="text-[12px] text-muted hover:text-fg">
        {name} · Download
      </a>
    </div>,
    document.body,
  );
}
