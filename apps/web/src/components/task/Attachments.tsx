import { useAtom, useAtomValue } from "@effect/atom-react"
import type { AttachmentRef, ComposerDraft } from "@huntaway/client"
import { clsx } from "clsx"
import { Exit } from "effect"
import type { Atom } from "effect/reactivity"
import { FileText, Loader2, Paperclip, X } from "lucide-react"
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react"
import { createPortal } from "react-dom"
import { resultError, resultValue } from "../ui"
import { exitError, useAction } from "../../state/mutation"
import { attachmentUrlAtom, isImage, uploadAttachment } from "./attachmentFiles"

interface Item {
  key: string
  name: string
  /** Set once it's uploaded. */
  ref?: AttachmentRef | undefined
}

let seq = 0

const NO_FILES: ReadonlyArray<AttachmentRef> = []

const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files")

/**
 * Files being attached to a prompt: pasted, dropped or picked, and uploaded to the host right away. Those uploaded are
 * kept in `draft` (the composer's), so a send takes them off it whether or not this is still mounted; this keeps only
 * the ones still uploading.
 */
export function useAttachmentDraft(hostId: string, draft: Atom.Writable<ComposerDraft | null>) {
  const [saved, setDraft] = useAtom(draft)
  const [pending, setPending] = useState<Item[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [, run] = useAction()
  const files = saved?.files ?? NO_FILES
  const setFiles = (change: (files: ReadonlyArray<AttachmentRef>) => ReadonlyArray<AttachmentRef>) =>
    setDraft((d) => ({ text: d?.text ?? "", files: change(d?.files ?? NO_FILES) }))

  const add = (picked: File[]) => {
    if (!picked.length) return
    setErr(null)
    for (const file of picked) {
      const key = `a${++seq}`
      setPending((cur) => [...cur, { key, name: file.name || "pasted file" }])
      void run(uploadAttachment(hostId, file)).then((exit) => {
        setPending((cur) => cur.filter((it) => it.key !== key))
        if (Exit.isSuccess(exit)) setFiles((cur) => [...cur, exit.value])
        else setErr(exitError(exit))
      })
    }
  }
  const items: Item[] = [...files.map((ref) => ({ key: ref.id, name: ref.name, ref })), ...pending]

  return {
    enabled: true,
    items,
    err,
    dragging,
    /** Uploaded files, in order. */
    files,
    uploading: pending.length > 0,
    add,
    remove: (key: string) => {
      setPending((cur) => cur.filter((it) => it.key !== key))
      setFiles((cur) => cur.filter((f) => f.id !== key))
    },
    /** Put back files that are already on the host. */
    restore: (refs: ReadonlyArray<AttachmentRef>) => setFiles((cur) => [...cur, ...refs]),
    clear: () => {
      setPending([])
      setFiles(() => NO_FILES)
      setErr(null)
    },
    onPaste: (e: ClipboardEvent) => {
      const picked = Array.from(e.clipboardData.files)
      if (!picked.length) return
      // Text copied along with a picture of it (e.g. spreadsheet cells) still pastes as text.
      if (!e.clipboardData.types.includes("text/plain")) e.preventDefault()
      add(picked)
    },
    /** Spread on the element that takes dropped files. */
    dropProps: {
      onDragOver: (e: DragEvent) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = "copy"
        setDragging(true)
      },
      onDragLeave: (e: DragEvent) => {
        if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setDragging(false)
      },
      onDrop: (e: DragEvent) => {
        setDragging(false)
        if (!hasFiles(e)) return
        e.preventDefault()
        add(Array.from(e.dataTransfer.files))
      },
    },
  }
}

export type AttachmentDraft = ReturnType<typeof useAttachmentDraft>

/** Paperclip button that picks files to attach. */
export function AttachButton({ draft, label, className }: { draft: AttachmentDraft; label?: string | undefined; className?: string | undefined }) {
  const input = useRef<HTMLInputElement>(null)
  if (!draft.enabled) return null
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
          draft.add(Array.from(e.target.files ?? []))
          e.target.value = ""
        }}
      />
    </>
  )
}

/** The files attached so far, each removable. */
export function DraftAttachments({ draft, hostId, className }: { draft: AttachmentDraft; hostId: string; className?: string | undefined }) {
  if (!draft.items.length && !draft.err) return null
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
  )
}

/** Files attached to a sent message. */
export function AttachmentList({ hostId, files, className }: { hostId: string; files: ReadonlyArray<AttachmentRef>; className?: string | undefined }) {
  if (!files.length) return null
  return (
    <div className={clsx("flex flex-wrap gap-2", className)}>
      {files.map((f) => (
        <Thumb key={f.path} hostId={hostId} file={f} />
      ))}
    </div>
  )
}

function Chip({ name, pending, url }: { name: string; pending?: boolean | undefined; url?: string | undefined }) {
  const body = (
    <>
      {pending ? <Loader2 size={13} className="shrink-0 animate-spin" /> : <FileText size={13} className="shrink-0" />}
      <span className="truncate">{name}</span>
    </>
  )
  const cls = "flex h-8 max-w-[220px] items-center gap-1.5 rounded-md border border-line bg-panel px-2 text-[12px] text-muted"
  return url ? (
    <a href={url} download={name} title={`Download ${name}`} className={clsx(cls, "hover:border-line-strong hover:text-fg")}>
      {body}
    </a>
  ) : (
    <div className={cls} title={name}>
      {body}
    </div>
  )
}

/** An image's thumbnail (opens full size), or a file's name (downloads it). */
function Thumb({ hostId, file }: { hostId: string; file: AttachmentRef }) {
  const result = useAtomValue(attachmentUrlAtom(hostId, file))
  const url = resultValue(result)
  const failed = resultError(result) !== null
  const [open, setOpen] = useState(false)
  if (!isImage(file.name) || failed) return <Chip name={failed ? `${file.name} (unavailable)` : file.name} url={url} />
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
  )
}

/** An image at full size over everything else. */
function Lightbox({ url, name, onClose }: { url: string; name: string; onClose: () => void }) {
  useEffect(() => {
    // Ahead of (and instead of) a dialog's or the task view's own Escape.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      e.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [onClose])
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-2 bg-black/80 p-6"
      onMouseDown={(e) => {
        e.stopPropagation()
        onClose()
      }}
    >
      <img src={url} alt={name} className="max-h-[90vh] max-w-[90vw] rounded-md object-contain shadow-2xl" />
      <a href={url} download={name} onMouseDown={(e) => e.stopPropagation()} className="text-[12px] text-muted hover:text-fg">
        {name} · Download
      </a>
    </div>,
    document.body,
  )
}
