// Comments on a document's pages (HA-302, API 134), as the hosted docs site has them: the user selects text in the page
// (its frame offers "Comment", see docFrame.ts), which quotes it, and leaves a comment for the agent. A comment belongs
// to the version it was made on: the panel lists the shown page's, and those on other pages and versions below them.
// "Send to the agent" sends the unsent ones to the task that published the document; agents also read them with the
// docs server's `get_feedback`.
import { clsx } from "clsx"
import { Check, ChevronRight, Loader2, MessageSquare, Pencil, Send, Trash2 } from "lucide-react"
import { useAtomValue } from "@effect/atom-react"
import { Effect, Exit } from "effect"
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react"
import { ProfileId, type DocComment, type DocComments, type DocPublisher } from "@huntaway/contracts"
import { mutate, query } from "@huntaway/client"
import { type DocsHome } from "./docs"
import { href } from "../../router"
import { navigate } from "../../state/route"
import { useAction, useMutation } from "../../state/mutation"
import { idle } from "./docsPage/reads"
import { Ago, Button, ErrorBox, IconButton, resultError, resultValue, Textarea } from "../ui"

/** A quote waiting for its comment: where it was made, and the text with its context. */
export type CommentDraft = { version: number; page: string; quote: string; prefix: string; suffix: string }

/**
 * A document's comments, read again on its host's `doc_comments` events (and after a change made here); null until
 * they're read (or when `on` is off).
 */
export function useDocComments(home: DocsHome | undefined, slug: string, on: boolean): { data: DocComments | null; error: string | null } {
  const result = useAtomValue(home && on ? query("docs.comments", home.hostId, { profile_id: ProfileId.make(home.profileId), slug }) : idle)
  return { data: resultValue(result) ?? null, error: resultError(result) }
}

function TaskLink({ task }: { task: DocPublisher }) {
  const to = href({ name: "task", taskId: task.id })
  const onClick = (e: MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    navigate(to)
  }
  return (
    <a href={to} onClick={onClick} className="text-muted hover:text-fg hover:underline" title={task.title}>
      {task.key ?? task.title}
    </a>
  )
}

/** A quote as the panel shows it: cut short, in a block quote. */
function Quote({ text, lines = 3, className }: { text: string; lines?: number; className?: string }) {
  return (
    <blockquote
      className={clsx("border-l-2 border-amber-400/60 pl-2 text-[12.5px] whitespace-pre-wrap text-muted", className)}
      style={{ display: "-webkit-box", WebkitLineClamp: lines, WebkitBoxOrient: "vertical", overflow: "hidden" }}
    >
      {text.length > 600 ? `${text.slice(0, 600)}…` : text}
    </blockquote>
  )
}

/** Ctrl/⌘+Enter saves and Escape cancels, in a comment's field. */
const keys = (save: () => void, cancel: () => void) => (e: KeyboardEvent) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    save()
  } else if (e.key === "Escape") {
    e.preventDefault()
    cancel()
  }
}

export function DocCommentsPanel({
  home,
  slug,
  data,
  loadError,
  version,
  page,
  draft,
  onDraftDone,
  found,
  active,
  onFocus,
  onGo,
}: {
  home: DocsHome
  slug: string
  data: DocComments | null
  loadError: string | null
  /** The version and page shown. */
  version: number | undefined
  page: string | undefined
  draft: CommentDraft | null
  onDraftDone: () => void
  /** The shown page's comments its frame found the quotes of, once it's said. */
  found: Set<number> | null
  active: number | null
  onFocus: (id: number) => void
  onGo: (version: number, page: string) => void
}) {
  const [send, sendComments] = useMutation("docs.sendComments")
  const [sent, setSent] = useState<{ n: number; task: DocPublisher } | null>(null)
  const comments = data?.comments ?? []
  const here = comments.filter((m) => m.version === version && m.page === page)
  const elsewhere = comments
    .filter((m) => !(m.version === version && m.page === page))
    .toSorted((a, b) => b.version - a.version || a.page.localeCompare(b.page))
  const unsent = comments.filter((m) => m.sent_at === null)
  const list = useRef<HTMLOListElement>(null)

  // A comment chosen in the page comes into view here.
  useEffect(() => {
    if (active !== null) list.current?.querySelector(`[data-comment="${active}"]`)?.scrollIntoView({ block: "nearest" })
  }, [active])

  const sendAll = () =>
    void sendComments(home.hostId, { profile_id: ProfileId.make(home.profileId), slug }).then((exit) => {
      if (Exit.isSuccess(exit)) setSent({ n: exit.value.sent, task: exit.value.task })
    })

  return (
    <aside aria-label="Comments" className="flex w-80 shrink-0 flex-col border-l border-line narrow:max-h-72 narrow:w-full narrow:border-t narrow:border-l-0">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <MessageSquare size={14} className="text-muted" />
        <h2 className="text-[13px] font-semibold">Comments</h2>
        {here.length > 0 && <span className="text-[12px] text-faint">{here.length}</span>}
        {data?.task && (
          <Button
            size="sm"
            variant={unsent.length && data.can_send ? "primary" : "secondary"}
            className="ml-auto"
            disabled={!data.can_send || !unsent.length || send.busy}
            onClick={sendAll}
            title={
              !data.can_send
                ? `${data.task.key ?? data.task.title} is in an archived project`
                : unsent.length
                  ? `Send ${unsent.length === 1 ? "the unsent comment" : `the ${unsent.length} unsent comments`} to ${data.task.key ?? data.task.title}, the task that published this document`
                  : "Every comment has been sent"
            }
          >
            {send.busy ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
            Send {unsent.length > 0 && unsent.length} to the agent
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-[13px]">
        {loadError && <ErrorBox>Couldn't load the comments: {loadError}</ErrorBox>}
        {send.error && <ErrorBox>Couldn't send them: {send.error}</ErrorBox>}
        {sent && !send.error && (
          <div className="flex items-center gap-1.5 text-[12px] text-emerald-300" role="status">
            <Check size={13} /> Sent {sent.n === 1 ? "a comment" : `${sent.n} comments`} to <TaskLink task={sent.task} />
          </div>
        )}
        {data && !data.task && unsent.length > 0 && (
          <p className="text-[12px] text-faint">
            No task that published this document is on the board to send them to; agents can still read them with get_feedback.
          </p>
        )}
        {draft ? (
          <DraftForm home={home} slug={slug} draft={draft} elsewhere={draft.version !== version || draft.page !== page} onDone={onDraftDone} />
        ) : (
          data && <p className="text-[12px] text-faint">Select text in the page to quote it and leave a comment for the agent.</p>
        )}
        {here.length > 0 && (
          <ol ref={list} className="space-y-2" aria-label="This page's comments">
            {here.map((m) => (
              <CommentItem key={m.id} home={home} slug={slug} c={m} missing={found !== null && !found.has(m.id)} active={active === m.id} onFocus={onFocus} />
            ))}
          </ol>
        )}
        {elsewhere.length > 0 && (
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-1 text-[12px] text-muted hover:text-fg">
              <ChevronRight size={13} className="transition-transform group-open:rotate-90" />
              {elsewhereLabel(elsewhere, version)}
            </summary>
            <ol className="mt-2 space-y-2">
              {elsewhere.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => onGo(m.version, m.page)}
                    className="w-full rounded-md border border-line/60 p-2 text-left hover:border-line hover:bg-white/[0.02]"
                    title={`Open v${m.version} · ${m.page}`}
                  >
                    <div className="mb-1 font-mono text-[11px] text-faint">
                      v{m.version} · {m.page}
                    </div>
                    <Quote text={m.quote} lines={2} />
                    {m.comment && <p className="mt-1 line-clamp-2 text-[12.5px] text-fg">{m.comment}</p>}
                  </button>
                </li>
              ))}
            </ol>
          </details>
        )}
      </div>
    </aside>
  )
}

/** "3 comments on other pages and versions", or just one of the two. */
function elsewhereLabel(elsewhere: DocComment[], version: number | undefined): string {
  const n = elsewhere.length
  const others = elsewhere.filter((m) => m.version !== version).length
  const where =
    others === 0
      ? "other pages"
      : others === n
        ? elsewhere.every((m) => version !== undefined && m.version < version)
          ? "earlier versions"
          : "other versions"
        : "other pages and versions"
  return `${n} comment${n === 1 ? "" : "s"} on ${where}`
}

function DraftForm({ home, slug, draft, elsewhere, onDone }: { home: DocsHome; slug: string; draft: CommentDraft; elsewhere: boolean; onDone: () => void }) {
  const [text, setText] = useState("")
  const [save, add] = useMutation("docs.addComment")
  const submit = () =>
    void add(home.hostId, { profile_id: ProfileId.make(home.profileId), slug, comment: { ...draft, comment: text.trim() } }).then((exit) => {
      if (!Exit.isSuccess(exit)) return
      setText("")
      onDone()
    })
  return (
    <form
      aria-label="New comment"
      className="space-y-2 rounded-md border border-accent/40 bg-accent/[0.04] p-2"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      {elsewhere && (
        <div className="font-mono text-[11px] text-faint">
          On v{draft.version} · {draft.page}
        </div>
      )}
      <Quote text={draft.quote} />
      <Textarea
        autoFocus
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={keys(submit, onDone)}
        placeholder="Comment for the agent (optional)"
        aria-label="Comment"
      />
      {save.error && <ErrorBox>Couldn't save it: {save.error}</ErrorBox>}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" type="button" onClick={onDone}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit" disabled={save.busy}>
          {save.busy && <Loader2 size={13} className="animate-spin" />} Save
        </Button>
      </div>
    </form>
  )
}

function CommentItem({
  home,
  slug,
  c,
  missing,
  active,
  onFocus,
}: {
  home: DocsHome
  slug: string
  c: DocComment
  missing: boolean
  active: boolean
  onFocus: (id: number) => void
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [act, run] = useAction()
  const profile_id = ProfileId.make(home.profileId)
  const saveEdit = () =>
    void run(
      mutate("docs.updateComment", home.hostId, { profile_id, slug, id: c.id, comment: (editing ?? "").trim() }).pipe(
        Effect.tap(() => Effect.sync(() => setEditing(null))),
      ),
    )
  const remove = () => void run(mutate("docs.deleteComment", home.hostId, { profile_id, slug, id: c.id }))
  return (
    <li
      data-comment={c.id}
      aria-label="Comment"
      className={clsx("group rounded-md border p-2", active ? "border-amber-400/60 bg-amber-400/[0.05]" : "border-line/60")}
    >
      <button
        type="button"
        className="block w-full text-left disabled:cursor-default"
        disabled={missing}
        onClick={() => onFocus(c.id)}
        title={missing ? "This quote isn't in the page as it's shown now" : "Show it in the page"}
      >
        <Quote text={c.quote} className={clsx(missing && "line-through decoration-faint")} />
      </button>
      {missing && <div className="mt-1 text-[11.5px] text-faint italic">Not found in the page</div>}
      {editing !== null ? (
        <div className="mt-2 space-y-2">
          <Textarea
            autoFocus
            rows={3}
            value={editing}
            onChange={(e) => setEditing(e.target.value)}
            onKeyDown={keys(saveEdit, () => setEditing(null))}
            aria-label="Edit comment"
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={saveEdit} disabled={act.busy}>
              Save
            </Button>
          </div>
        </div>
      ) : (
        c.comment && <p className="mt-1.5 text-[13px] whitespace-pre-wrap text-fg">{c.comment}</p>
      )}
      {act.error && <ErrorBox className="mt-2">{act.error}</ErrorBox>}
      <footer className="mt-1.5 flex items-center gap-1 text-[11.5px] text-faint">
        <Ago at={c.created_at} />
        <span>· {c.sent_at ? "sent" : "not sent yet"}</span>
        {editing === null && (
          <span className="ml-auto flex opacity-60 group-hover:opacity-100">
            <IconButton title="Edit comment" onClick={() => setEditing(c.comment)}>
              <Pencil size={12} />
            </IconButton>
            <IconButton title="Delete comment" onClick={remove} disabled={act.busy}>
              <Trash2 size={12} />
            </IconButton>
          </span>
        )}
      </footer>
    </li>
  )
}
