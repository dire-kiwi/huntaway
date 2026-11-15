import { assert, describe, it } from "@effect/vitest"
import { memory, notesBefore } from "../../prompts/memory.ts"
import type { Note } from "../../prompts/memory.ts"
import { isLog, mayBeNote, namesKeyword, notesNamed, parseNote, splitFrontmatter } from "./notes.ts"
import { loaded, memoryFile, withWeekday } from "./text.ts"

// The assistant's notes by topic (HE-36): their frontmatter read, their keywords matched, and how a run is told them.

const INVOICES =
  "---\n" +
  "name: Invoices\n" +
  "description: How the user bills their clients # and who\n" +
  "keywords: [invoice, billing, 'Xero', \"tax return\"]\n" +
  "metadata:\n" +
  "  type: project\n" +
  "---\n" +
  "\n" +
  "# Invoices\n- Sent on the 1st, through Xero.\n"

const note = (rel: string, keywords: ReadonlyArray<string>): Note => ({ rel, name: rel, description: "", type: null, keywords })

describe("notes by topic", () => {
  it("a note's frontmatter is read: its name, description, type and keywords", () => {
    const parsed = parseNote("memory/invoices.md", INVOICES) ?? assert.fail("not a note")
    assert.deepStrictEqual(parsed.note, {
      rel: "memory/invoices.md",
      name: "Invoices",
      description: "How the user bills their clients",
      type: "project",
      keywords: ["invoice", "billing", "Xero", "tax return"],
    })
    assert.strictEqual(parsed.body, "# Invoices\n- Sent on the 1st, through Xero.\n")
  })

  it("keywords may be a list of lines, words split by commas, or triggers; the type may be at the top", () => {
    const lines = parseNote("memory/car.md", '---\r\ntype: reference\r\nkeywords:\r\n  - car\r\n  - "Mog\'s vet"\r\n---\r\nbody')
    assert.deepStrictEqual(lines?.note.keywords, ["car", "Mog's vet"])
    assert.strictEqual(lines?.note.type, "reference")
    // No name: the file's.
    assert.strictEqual(lines?.note.name, "car")
    const commas = parseNote("memory/a.md", "---\ndescription: >\n  Two\n  lines\nkeywords: one, two words\ntriggers: [three, one]\n---\n")
    assert.deepStrictEqual(commas?.note.keywords, ["one", "two words", "three"])
    assert.strictEqual(commas?.note.description, "Two lines")
    // Nested keys under metadata, and a list at the key's own indent.
    const nested = splitFrontmatter("---\nmetadata:\n  type: user\n  keywords:\n  - a\nname: x\n---\n").fields
    assert.deepStrictEqual(nested?.get("metadata.keywords"), ["a"])
    assert.strictEqual(nested?.get("metadata.type"), "user")
    assert.strictEqual(nested?.get("name"), "x")
  })

  it("a type that isn't one of the four is none", () => {
    for (const t of ["user", "feedback", "project", "reference"])
      assert.strictEqual(parseNote("memory/a.md", `---\nkeywords: a\ntype: ${t}\n---\n`)?.note.type, t)
    assert.isNull(parseNote("memory/a.md", "---\nkeywords: a\nmetadata:\n  type: secret\n---\n")?.note.type)
  })

  it("a file without keywords, or without frontmatter, isn't a note", () => {
    assert.isNull(parseNote("memory/a.md", "# Just notes\n- keywords: a\n"))
    assert.isNull(parseNote("memory/a.md", "---\nname: A\ndescription: no keywords\n---\nbody"))
    assert.isNull(parseNote("memory/a.md", "---\nkeywords: []\n---\n"))
    assert.isNull(parseNote("memory/a.md", "---\nkeywords: [a]\nno end"))
    assert.isNull(splitFrontmatter("text\n---\nkeywords: a\n---\n").fields)
  })

  it("daily logs aren't notes", () => {
    assert.isTrue(isLog("memory/2026-11-16.md"))
    assert.isFalse(isLog("memory/invoices.md") || isLog("memory/a/2026-11-16.md") || isLog("2026-11-16.md"))
    assert.isTrue(mayBeNote("invoices.md"))
    assert.isFalse(mayBeNote("2026-11-16.md") || mayBeNote("notes.txt") || mayBeNote(".hidden.md"))
  })

  it("a keyword is matched as whole words, in any case", () => {
    assert.isTrue(namesKeyword("Did the INVOICE go out?", "invoice"))
    assert.isTrue(namesKeyword("about my tax\n  return", "Tax Return"))
    assert.isTrue(namesKeyword("(Xero)", "xero"))
    assert.isTrue(namesKeyword("Ein Überweisung", "überweisung"))
    assert.isFalse(namesKeyword("the invoices", "invoice"))
    assert.isFalse(namesKeyword("reinvoice", "invoice"))
    assert.isFalse(namesKeyword("tax season, return it", "tax return"))
    // A keyword ending in `*` is the start of a word.
    assert.isTrue(namesKeyword("three invoices", "invoic*"))
    assert.isFalse(namesKeyword("reinvoiced", "invoic*"))
    // What a regular expression would read as its own isn't.
    assert.isTrue(namesKeyword("I use C++ daily", "c++"))
    assert.isFalse(namesKeyword("anything", "a.y"))
    assert.isFalse(namesKeyword("anything", "*"))
  })

  it("only the notes a message names a keyword of match", () => {
    const notes = [note("memory/invoices.md", ["invoice", "billing"]), note("memory/car.md", ["car"])]
    assert.deepStrictEqual(
      notesNamed(notes, "Is billing done?").map((n) => n.rel),
      ["memory/invoices.md"],
    )
    assert.deepStrictEqual(notesNamed(notes, "Book a table for two"), [])
    assert.deepStrictEqual(notesNamed(notes, ""), [])
  })

  it("a run's instructions list the notes by path, name and description, not what they say", () => {
    const parsed = parseNote("memory/invoices.md", INVOICES) ?? assert.fail("not a note")
    const [, , y, t] = loaded("2026-11-16")
    const none = { _tag: "Missing" } as const
    const text = memory({
      dir: "/ws",
      today: withWeekday("2026-11-16"),
      user: none,
      memory: none,
      yesterdayLog: { rel: y, file: none },
      todayLog: { rel: t, file: none },
      notes: [parsed.note],
    })
    assert.include(text, "### Notes by topic")
    assert.include(text, "\n- `memory/invoices.md` (project): Invoices — How the user bills their clients")
    assert.notInclude(text, "Sent on the 1st")
    // And how to use them: read one when its topic comes up.
    assert.include(text, "read the note at its path before you answer or act on it: don't go on its line below alone")
    const empty = memory({ dir: "/ws", today: "", user: none, memory: none, yesterdayLog: { rel: y, file: none }, todayLog: { rel: t, file: none }, notes: [] })
    assert.include(empty, "There are no notes by topic in `memory/` yet.")
  })

  it("a note put before a message is its body, cut at the cap with a pointer to the rest", () => {
    const parsed = parseNote("memory/invoices.md", INVOICES) ?? assert.fail("not a note")
    const text = notesBefore([{ note: parsed.note, file: memoryFile(parsed.body, false, 8000, 16384) }], [note("memory/car.md", ["car"])])
    assert.isTrue(text.startsWith("<memory-notes>\n") && text.endsWith("</memory-notes>\n\n"), text)
    assert.include(text, '<memory-file path="memory/invoices.md">\n# Invoices\n- Sent on the 1st, through Xero.\n</memory-file>')
    assert.include(text, "aren't loaded here too: `memory/car.md`")
    const cut = notesBefore([{ note: parsed.note, file: memoryFile("x".repeat(9000), false, 8000, 16384) }], [])
    assert.include(cut, "is 9,000 characters, over the 8,000 that are loaded: read the file for the rest")
    assert.strictEqual(notesBefore([], []), "")
  })
})
