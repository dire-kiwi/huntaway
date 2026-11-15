import { describe, expect, it } from "@effect/vitest"
import { draftOf, editedInput, eventWhen, mailEdit, mailFrameDoc, type EventDraft, type MailDraft } from "../../src/components/task/thread/drafts"

// HE-23, the "Show outgoing mail and events as drafts" experiment: which prompts are drawn as a mail or an event, what
// they say, and the input an edited mail is sent with. The tools and arguments are workspace-mcp 2.3.0's.

const mail = (input: unknown, tool = "mcp__google__send_gmail_message"): MailDraft => {
  const d = draftOf(tool, input)
  if (d?.type !== "mail") throw new Error("not a mail")
  return d
}
const event = (input: unknown, tool = "mcp__google__manage_event"): EventDraft => {
  const d = draftOf(tool, input)
  if (d?.type !== "event") throw new Error("not an event")
  return d
}

describe("draftOf", () => {
  it("reads a mail to send, and a draft to save", () => {
    const sent = mail({
      to: "kim@example.com",
      cc: "sam@example.com",
      subject: "Invoice 4411",
      body: "Paid today.\nThanks",
      user_google_email: "me@example.com",
    })
    expect(sent).toMatchObject({ type: "mail", draft: false, to: "kim@example.com", cc: "sam@example.com", bcc: "", subject: "Invoice 4411", html: false })
    expect(sent.body).toBe("Paid today.\nThanks")
    expect(mail({ to: "a@b.c", body: "<p>Hi</p>", body_format: "html" }, "mcp__google__draft_gmail_message")).toMatchObject({ draft: true, html: true })
    // A reply, a forward and attachments.
    expect(mail({ thread_id: "t1", body: "Yes", reply_all: true })).toMatchObject({ to: "", thread: "t1" })
    expect(mail({ to: "x@y.z", forward_message_id: "m1" })).toMatchObject({ forward: "m1", body: "" })
    expect(mail({ to: "a@b.c", body: "See", attachments: [{ path: "/tmp/q3.pdf" }, { url: "https://h/a", filename: "notes.txt" }] }).attachments).toEqual([
      "q3.pdf",
      "notes.txt",
    ])
  })

  it("reads Codex's prompt, which has the tool's arguments beside its question", () => {
    expect(mail({ message: "Allow the google server to run send_gmail_message?", arguments: { to: "a@b.c", subject: "Hi", body: "Yo" } })).toMatchObject({
      to: "a@b.c",
      subject: "Hi",
    })
  })

  it("reads an event to add, and what a change changes", () => {
    const made = event({
      action: "create",
      summary: "1:1 with Sam",
      start_time: "2026-11-16T14:00:00",
      end_time: "2026-11-16T14:30:00",
      timezone: "Pacific/Auckland",
      attendees: ["sam@example.com", { email: "kim@example.com", responseStatus: "accepted" }],
      location: "Queen St",
      description: "Catch up",
      add_google_meet: true,
    })
    expect(made).toMatchObject({ action: "create", title: "1:1 with Sam", zone: "Pacific/Auckland", location: "Queen St", meet: true, changes: [] })
    expect(made.attendees).toEqual(["sam@example.com", "kim@example.com"])
    expect(eventWhen(made)).toBe("Mon 16 Nov 2026, 14:00 – 14:30 (Pacific/Auckland)")
    const moved = event({
      action: " Update ",
      event_id: "ev2",
      start_time: "2026-11-16T15:00:00+13:00",
      end_time: "2026-11-16T15:30:00+13:00",
      location: "Online",
    })
    expect(moved).toMatchObject({ action: "update", event: "ev2", changes: ["the time", "the place"] })
    expect(eventWhen(moved)).toBe("Mon 16 Nov 2026, 15:00 – 15:30 (UTC+13:00)")
  })

  it("says when an all-day event is, and a time that doesn't read as it was given", () => {
    expect(eventWhen({ start: "2026-12-24", end: "2026-12-25", zone: "" })).toBe("Thu 24 Dec 2026 – Fri 25 Dec 2026 (all day, to the end before)")
    expect(eventWhen({ start: "tomorrow at 3", end: "", zone: "Europe/London" })).toBe("tomorrow at 3 (Europe/London)")
    expect(eventWhen({ start: "2026-11-16T09:00:00Z", end: "2026-11-17T10:00:00Z", zone: "" })).toBe("Mon 16 Nov 2026, 09:00 – Tue 17 Nov 2026, 10:00 (UTC)")
  })

  it("is null for any other tool or action, and for an input that isn't one", () => {
    expect(draftOf("Bash", { command: "ls" })).toBeNull()
    expect(draftOf("mcp__google__search_gmail_messages", { query: "is:unread" })).toBeNull()
    expect(draftOf("mcp__google__manage_event", { action: "delete", event_id: "ev1" })).toBeNull()
    expect(draftOf("mcp__google__manage_event", { action: "rsvp", event_id: "ev1", response: "accepted" })).toBeNull()
    expect(draftOf("mcp__google__send_gmail_message", "not an object")).toBeNull()
    expect(draftOf("mcp__google__send_gmail_message", {})).toBeNull()
    expect(draftOf("mcp__google__manage_event", { action: "create" })).toBeNull()
  })
})

describe("editedInput", () => {
  const input = { to: "kim@example.com", cc: "sam@example.com", subject: "Invoice", body: "Paid.", body_format: "plain", user_google_email: "me@x.com" }
  const was = mail(input)

  it("is null when nothing changed", () => {
    expect(editedInput(input, was, mailEdit(was))).toBeNull()
  })

  it("is the tool's input with the fields edited, and an address emptied left out", () => {
    expect(editedInput(input, was, { ...mailEdit(was), to: "kim@example.org", cc: "", body: "Paid on Monday." })).toEqual({
      to: "kim@example.org",
      subject: "Invoice",
      body: "Paid on Monday.",
      body_format: "plain",
      user_google_email: "me@x.com",
    })
    expect(editedInput(input, was, { ...mailEdit(was), bcc: "me@x.com" })).toEqual({ ...input, bcc: "me@x.com" })
  })
})

describe("mailFrameDoc", () => {
  it("puts the policy before anything of the mail's: no scripts, and no images but data: ones", () => {
    const doc = mailFrameDoc("<img src=https://tracker.example/p.gif><script>alert(1)</script>")
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<img"))
    expect(doc).toContain("default-src 'none'")
    expect(doc).toContain("img-src data:;")
    expect(doc).not.toContain("script-src")
  })
})
