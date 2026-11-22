// What fake-claude answers interactive-reply prompts with (HE-77; fake-claude.ts says when): a form, the board's
// `Choice` macro, a Modal, and the update a click gets. A file of its own so fake-claude stays under the size limit.

/** The form a "fake-a2ui" prompt is answered with. */
export const FAKE_A2UI_FORM = [
  "Here's a form:",
  "<a2ui>",
  'surface("fake-form")',
  '$/form/title = "A title"',
  'save = Button(Text("Save"), variant="primary", action=Event("save", {title: $/form/title}))',
  'skip = Button(Text("Skip"), action=Event("skip"))',
  'root = Card(Column([Text("**Name the task**"), TextField("Title", $/form/title), Row([save, skip])]))',
  "</a2ui>",
  "Pick one.",
].join("\n")

/** The `Choice` macro a "fake-a2ui-choice" prompt is answered with. */
export const FAKE_A2UI_CHOICE = [
  "Which way?",
  "<a2ui>",
  'surface("fake-choice")',
  'root = Choice("Which approach should I take?", [{label: "Small change", value: "small"}, {label: "Rewrite", value: "rewrite"}], event="approach")',
  "</a2ui>",
].join("\n")

/** A Modal whose trigger is a Button (with the action the catalog requires) and whose content is a short form. */
export const FAKE_A2UI_MODAL = [
  "Open it:",
  "<a2ui>",
  'surface("fake-modal")',
  '$/note = ""',
  'open = Button(Text("Details"), action=Event("open"))',
  'save = Button(Text("Save note"), variant="primary", action=Event("note", {note: $/note}))',
  'root = Modal(open, Column([TextField("Note", $/note), save]))',
  "</a2ui>",
].join("\n")

/** What a prompt with "fake-a2ui" in it is answered with: the Choice, the Modal or (by default) the form. */
export const fakeA2uiReply = (text: string): string =>
  text.includes("fake-a2ui-choice") ? FAKE_A2UI_CHOICE : text.includes("fake-a2ui-modal") ? FAKE_A2UI_MODAL : FAKE_A2UI_FORM

/** The reply to a click: its surface, updated to say what was chosen (`action` is the click's JSON). */
export const fakeA2uiDone = (action: string): string => {
  let parsed: { surfaceId?: unknown; name?: unknown; context?: unknown } = {}
  try {
    parsed = JSON.parse(action)
  } catch {
    // Not JSON: answered as a click on nothing.
  }
  const surface = typeof parsed.surfaceId === "string" ? parsed.surfaceId : "fake-form"
  const said = JSON.stringify({ name: parsed.name, context: parsed.context }).replaceAll("\\", "\\\\").replaceAll('"', '\\"')
  return ["Done.", "<a2ui>", `surface(${JSON.stringify(surface)}, update=true)`, `root = Card(Text("Got ${said}"))`, "</a2ui>"].join("\n")
}
