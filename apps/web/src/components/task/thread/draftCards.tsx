import { askerName } from "@huntaway/client"
import { clsx } from "clsx"
import { CalendarClock, CalendarPlus, Check, ChevronRight, Clock, Mail, MapPin, Paperclip, Pencil, Repeat, Send, Users, Video } from "lucide-react"
import { memo, useState, type ReactNode } from "react"
import { useAction } from "../../../state/mutation"
import { Button, Input, Textarea } from "../../ui"
import { editedInput, eventWhen, mailEdit, mailFrameDoc, type Draft, type EventDraft, type MailDraft, type MailEdit } from "./drafts"
import { answerPrompt } from "./promptAnswers"
import type { PromptData } from "./threadModel"

// The "Show outgoing mail and events as drafts" experiment (Settings → Experiments, docs/plan/09-frontend.md): a
// prompt for a tool a person reads as a message, drawn as that message (drafts.ts reads it). A mail is sent
// (**Send**, the prompt's Allow) or discarded (Deny), and on Claude Code edited first: its To, Cc, Bcc, Subject and
// body go back as the tool's input (`permissions.answer`'s `input`, Claude's `updatedInput`). An event is added or
// changed, or discarded. _Always allow_ stays where it is.

const asker = (data: PromptData) => askerName(data.agent)

/** What became of a draft, once it's settled. */
function Settled({ data, allowed }: { data: PromptData; allowed: string }) {
  const tone = data.status === "allowed" ? "good" : data.status === "denied" || data.status === "skipped" ? "bad" : "plain"
  const said = data.status === "allowed" ? allowed : data.status === "denied" ? "discarded" : data.status === "skipped" ? "not sent" : data.status
  return (
    <span
      className={clsx(
        "ml-auto shrink-0 rounded px-1.5 py-0.5 text-[11px]",
        tone === "good" ? "bg-emerald-500/10 text-emerald-300" : tone === "bad" ? "bg-red-500/10 text-red-300" : "bg-white/5 text-faint",
      )}
    >
      {said}
    </span>
  )
}

/** A row of a mail's or an event's: its label, and what it says. */
function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 py-0.5">
      <span className={clsx("shrink-0 text-[11.5px] text-faint", typeof label === "string" ? "w-14" : "w-4 self-center")}>{label}</span>
      <span className="min-w-0 flex-1 break-words">{children}</span>
    </div>
  )
}

/**
 * A mail's HTML body in a frame of its own, as the board's documents are: sandboxed without scripts, under a policy
 * that loads nothing from elsewhere (drafts.ts' MAIL_CSP). It's of the page's origin only so the page can size it to
 * its content; without scripts it can do nothing with that.
 */
function HtmlBody({ html }: { html: string }) {
  const [height, setHeight] = useState(120)
  return (
    <iframe
      title="The mail's body"
      srcDoc={mailFrameDoc(html)}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      onLoad={(e) => {
        const doc = e.currentTarget.contentDocument
        if (doc) setHeight(Math.min(480, Math.max(60, doc.documentElement.scrollHeight)))
      }}
      style={{ height }}
      className="block w-full rounded-b-md bg-white"
    />
  )
}

/** The mail as it would go out, or the fields to edit it in. */
function MailView({ mail, edit, onEdit }: { mail: MailDraft; edit: MailEdit | null; onEdit: (e: MailEdit) => void }) {
  const field = (k: keyof MailEdit, label: string) => (
    <Row label={label}>
      <Input aria-label={label} value={edit?.[k] ?? ""} onChange={(e) => edit && onEdit({ ...edit, [k]: e.target.value })} className="h-7" />
    </Row>
  )
  return (
    <div className="overflow-hidden rounded-md border border-line bg-panel-2 text-[13px]" data-draft="mail">
      <div className="border-b border-line px-3 py-1.5">
        {edit ? (
          <>
            {field("to", "To")}
            {field("cc", "Cc")}
            {field("bcc", "Bcc")}
            {field("subject", "Subject")}
          </>
        ) : (
          <>
            <Row label="To">{mail.to || <span className="text-faint">{mail.thread ? "(the thread's sender)" : "(nobody)"}</span>}</Row>
            {mail.cc && <Row label="Cc">{mail.cc}</Row>}
            {mail.bcc && <Row label="Bcc">{mail.bcc}</Row>}
            <Row label="Subject">
              <span className="font-semibold text-fg">
                {mail.subject || <span className="font-normal text-faint">{mail.forward ? "Fwd: (its subject)" : "(none)"}</span>}
              </span>
            </Row>
          </>
        )}
        {mail.thread && <Row label="">A reply in its thread</Row>}
        {mail.forward && <Row label="">Forwards a message{mail.body ? ", with this note above it" : ""}</Row>}
      </div>
      {edit ? (
        <div className="p-2">
          <Textarea
            aria-label={mail.html ? "Body (HTML)" : "Body"}
            rows={Math.min(16, Math.max(5, edit.body.split("\n").length + 1))}
            value={edit.body}
            onChange={(e) => onEdit({ ...edit, body: e.target.value })}
            className={clsx(mail.html && "font-mono text-[12px]")}
          />
          {mail.html && <div className="mt-1 text-[11.5px] text-faint">The body is HTML: you're editing its markup.</div>}
        </div>
      ) : mail.html && mail.body ? (
        <HtmlBody html={mail.body} />
      ) : (
        <div className="max-h-[28rem] overflow-auto px-3 py-2 whitespace-pre-wrap text-fg">{mail.body || <span className="text-faint">(no body)</span>}</div>
      )}
      {mail.attachments.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-3 py-1.5 text-[12px] text-muted">
          <Paperclip size={12} className="text-faint" />
          {mail.attachments.join(", ")}
        </div>
      )}
    </div>
  )
}

interface CardProps {
  readonly data: PromptData
  readonly hostId: string
  /** Which subagent asked (PromptFrom). */
  readonly from: ReactNode
  /** Why it asks (PromptRule) and whether it was skipped. */
  readonly footer: ReactNode
}

/** Allow (as `allow`), Always allow (unless a rule asks each time) and Discard, while it waits. */
function Answers({
  data,
  busy,
  error,
  allow,
  decide,
  children,
}: {
  data: PromptData
  busy: boolean
  error: string | null
  allow: ReactNode
  decide: (d: "allow" | "allow_always" | "deny") => void
  children?: ReactNode
}) {
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      <Button size="sm" variant="primary" disabled={busy} onClick={() => decide("allow")} className="narrow:px-4">
        {allow}
      </Button>
      {children}
      {/* What an approval rule asks about is asked each time. */}
      {!data.rule && (
        <Button
          size="sm"
          disabled={busy}
          onClick={() => decide("allow_always")}
          className="narrow:order-last narrow:h-auto narrow:min-h-9 narrow:py-1.5 narrow:break-all narrow:whitespace-normal"
        >
          Always allow {data.tool_name} for this thread
        </Button>
      )}
      <Button size="sm" variant="danger" disabled={busy} onClick={() => decide("deny")} className="narrow:px-4">
        Discard
      </Button>
      {error && <span className="self-center text-xs text-red-400">{error}</span>}
    </div>
  )
}

/** A settled draft, shown in a line until it's opened. */
function Folded({ summary, open, onToggle, children }: { summary: ReactNode; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <>
      <button className="flex max-w-full items-center gap-1 text-left text-[12px] text-faint hover:text-muted" onClick={onToggle} aria-expanded={open}>
        <ChevronRight size={12} className={clsx("shrink-0 transition-transform", open && "rotate-90")} />
        <span className="truncate">{summary}</span>
      </button>
      {open && <div className="mt-1.5">{children}</div>}
    </>
  )
}

const MailCard = memo(function MailCard({ data, hostId, from, footer, mail }: CardProps & { mail: MailDraft }) {
  const pending = data.status === "pending"
  // Codex's (and an ACP agent's) approval says yes or no: it can't carry an edited mail.
  const editable = data.agent !== "codex" && data.agent !== "acp"
  const [edit, setEdit] = useState<MailEdit | null>(null)
  const [open, setOpen] = useState(false)
  const [{ busy, error }, run] = useAction()
  const input = edit ? editedInput(data.input, mail, edit) : null
  const decide = (decision: "allow" | "allow_always" | "deny") =>
    void run(answerPrompt(hostId, data.request_id, decision !== "deny" && input !== null ? { decision, input } : { decision }))
  const verb = mail.draft ? "save a draft" : "send a mail"
  const pane = <MailView mail={mail} edit={pending ? edit : null} onEdit={setEdit} />
  return (
    <div
      role="group"
      aria-label={mail.draft ? "Draft mail" : "Mail to send"}
      className={clsx("rounded-lg border p-3", pending ? "border-st-attention/50 bg-st-attention/[0.06]" : "border-line bg-panel/60")}
    >
      <div className="mb-2 flex items-center gap-2 text-[13px]">
        <Mail size={15} className={pending ? "text-st-attention" : "text-faint"} />
        <span className={pending ? "text-fg" : "text-muted"}>{pending ? `${asker(data)} wants to ${verb}` : mail.draft ? "A draft" : "A mail"}</span>
        {from}
        {!pending && <Settled data={data} allowed={mail.draft ? "saved" : "sent"} />}
      </div>
      {pending ? (
        pane
      ) : (
        <Folded
          open={open}
          onToggle={() => setOpen(!open)}
          summary={
            <>
              To {mail.to || "(nobody)"}
              {mail.subject && ` · ${mail.subject}`}
            </>
          }
        >
          {pane}
        </Folded>
      )}
      {pending && input !== null && <div className="mt-1.5 text-[12px] text-st-attention">Edited: it goes as you see it here.</div>}
      {!pending && data.edited && (
        <div className="mt-1.5 text-[12px] text-muted">{data.status === "allowed" ? (mail.draft ? "Saved" : "Sent") : "Allowed"} as you edited it.</div>
      )}
      {footer}
      {pending && (
        <Answers
          data={data}
          busy={busy}
          error={error}
          decide={decide}
          allow={
            <>
              <Send size={13} /> {mail.draft ? "Save draft" : "Send"}
              {input !== null && " as edited"}
            </>
          }
        >
          {editable &&
            (edit ? (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEdit(null)} title="Put the mail back as the agent wrote it">
                Undo edits
              </Button>
            ) : (
              <Button size="sm" disabled={busy} onClick={() => setEdit(mailEdit(mail))}>
                <Pencil size={13} /> Edit
              </Button>
            ))}
        </Answers>
      )}
    </div>
  )
})

/** An event as it would be made, or the parts of one an update sets. */
function EventView({ event }: { event: EventDraft }) {
  const when = eventWhen(event)
  return (
    <div className="rounded-md border border-line bg-panel-2 px-3 py-2 text-[13px]" data-draft="event">
      {event.title && <div className="mb-1 text-[14px] font-semibold text-fg">{event.title}</div>}
      {when && (
        <Row label={<Clock size={12} aria-label="When" />}>
          <span className="text-fg">{when}</span>
        </Row>
      )}
      {event.attendees.length > 0 && <Row label={<Users size={12} aria-label="Attendees" />}>{event.attendees.join(", ")}</Row>}
      {event.location && <Row label={<MapPin size={12} aria-label="Where" />}>{event.location}</Row>}
      {event.meet && <Row label={<Video size={12} aria-label="Video call" />}>Google Meet</Row>}
      {event.recurrence.length > 0 && (
        <Row label={<Repeat size={12} aria-label="Repeats" />}>
          <span className="font-mono text-[12px]">{event.recurrence.join(", ")}</span>
        </Row>
      )}
      {event.description && <div className="mt-1.5 max-h-60 overflow-auto border-t border-line pt-1.5 whitespace-pre-wrap text-muted">{event.description}</div>}
    </div>
  )
}

/** "the title, the time and the place". */
const listed = (xs: ReadonlyArray<string>) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1] ?? ""}`)

const EventCard = memo(function EventCard({ data, hostId, from, footer, event }: CardProps & { event: EventDraft }) {
  const pending = data.status === "pending"
  const [open, setOpen] = useState(false)
  const [{ busy, error }, run] = useAction()
  const decide = (decision: "allow" | "allow_always" | "deny") => void run(answerPrompt(hostId, data.request_id, { decision }))
  const create = event.action === "create"
  const Icon = create ? CalendarPlus : CalendarClock
  const pane = (
    <>
      {!create && (
        <div className="mb-1.5 text-[12.5px] text-muted">
          {event.changes.length ? `Changes ${listed(event.changes)}` : "Changes the event"}
          {event.title ? "" : event.event ? ` of event ${event.event}` : ""}
          {event.changes.length ? ", to:" : "."}
        </div>
      )}
      {(create || event.changes.length > 0) && <EventView event={event} />}
    </>
  )
  return (
    <div
      role="group"
      aria-label={create ? "Event to add" : "Event to change"}
      className={clsx("rounded-lg border p-3", pending ? "border-st-attention/50 bg-st-attention/[0.06]" : "border-line bg-panel/60")}
    >
      <div className="mb-2 flex items-center gap-2 text-[13px]">
        <Icon size={15} className={pending ? "text-st-attention" : "text-faint"} />
        <span className={pending ? "text-fg" : "text-muted"}>
          {pending ? `${asker(data)} wants to ${create ? "add an event" : "change an event"}` : create ? "An event" : "A change to an event"}
        </span>
        {from}
        {!pending && <Settled data={data} allowed={create ? "added" : "changed"} />}
      </div>
      {pending ? (
        pane
      ) : (
        <Folded open={open} onToggle={() => setOpen(!open)} summary={[event.title || "(untitled)", eventWhen(event)].filter(Boolean).join(" · ")}>
          {pane}
        </Folded>
      )}
      {footer}
      {pending && (
        <Answers
          data={data}
          busy={busy}
          error={error}
          decide={decide}
          allow={
            <>
              <Check size={13} /> {create ? "Add the event" : "Change the event"}
            </>
          }
        />
      )}
    </div>
  )
})

/** A prompt for a tool a person reads as a message (`draft`, from drafts.ts' `draftOf`), drawn as that message. */
export function DraftCard({ draft, ...props }: CardProps & { draft: Draft }) {
  return draft.type === "mail" ? <MailCard {...props} mail={draft} /> : <EventCard {...props} event={draft} />
}
