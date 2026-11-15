// What the assistant (and its routine threads) is told about its memory, with its files as they are when the run
// starts (huntaway's agent/assistant/memory/prompt.ts prompt and for_run). Plan task 6.7 (`Memory`), which reads the
// files and cuts them to `MEMORY_CAP`. A conversation's first run is told them last in its instructions; a later run of
// it whose files changed is told what they say now at the start of its message (`memoryUpdate`, HE-25), as Claude Code
// and Codex keep the instructions a conversation started with (Claude Code until it's compacted).

export const USER_FILE = "USER.md"
export const MEMORY_FILE = "MEMORY.md"
/** The folder of daily logs. */
export const LOG_DIR = "memory"
/** How many characters of each file a run is told, and how many bytes. */
export const MEMORY_CAP = 8000
export const MEMORY_CAP_BYTES = 16 * 1024
/** The tag a memory update is wrapped in, and the one notes put before a message are (HE-36). */
export const UPDATE_TAG = "memory-update"
export const NOTES_TAG = "memory-notes"

/** What a note by topic is about, as Claude Code's memories say. */
export const NOTE_TYPES = ["user", "feedback", "project", "reference"] as const
export type NoteType = (typeof NOTE_TYPES)[number]

/** A note by topic (`memory/<topic>.md` with keywords in its frontmatter): listed by name and description, not loaded. */
export interface Note {
  readonly rel: string
  readonly name: string
  readonly description: string
  readonly type: NoteType | null
  readonly keywords: ReadonlyArray<string>
}

/** `n` with commas between thousands. */
export const formatNumber = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",")

/** A memory file as it is read: missing, empty, or `shown` (cut from `total` characters when `cut`). */
export type MemoryFile =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Shown"; readonly shown: string; readonly cut: boolean; readonly total: number }

export interface MemoryFacts {
  /** The workspace. */
  readonly dir: string
  /** The host's date with its weekday: `2026-11-12 (Thursday)`. */
  readonly today: string
  readonly user: MemoryFile
  readonly memory: MemoryFile
  /** `memory/<yesterday>.md` and `memory/<today>.md`. */
  readonly yesterdayLog: { readonly rel: string; readonly file: MemoryFile }
  readonly todayLog: { readonly rel: string; readonly file: MemoryFile }
  /** The notes by topic, by path. */
  readonly notes: ReadonlyArray<Note>
}

/** What changed in a file since the conversation was last told it: what it says now, or (a log) what was added at its end. */
export type MemoryChange = { readonly _tag: "Whole"; readonly file: MemoryFile } | { readonly _tag: "Added"; readonly added: string }

/** The files of `t` in the order they're told: path, heading, whether its end is shown, what's said when it's missing, the file. */
const files = (t: MemoryFacts) =>
  [
    [USER_FILE, USER_FILE, false, `\`${USER_FILE}\` isn't there: make it when you learn something about the user.`, t.user],
    [MEMORY_FILE, MEMORY_FILE, false, `\`${MEMORY_FILE}\` isn't there: make it when there's something to keep.`, t.memory],
    [t.yesterdayLog.rel, `Yesterday's log (${t.yesterdayLog.rel})`, true, "There's no log for yesterday.", t.yesterdayLog.file],
    [t.todayLog.rel, `Today's log (${t.todayLog.rel})`, true, "There's no log for today yet.", t.todayLog.file],
  ] as const

/** A file's section: its heading, then the file (or what's said when it's missing, empty or cut). */
const section = (rel: string, label: string, tail: boolean, missing: string, f: MemoryFile): string => {
  let s = `\n\n### ${label}\n\n`
  if (f._tag === "Missing") return s + missing
  if (f._tag === "Empty") return s + `\`${rel}\` is empty.`
  const capText = formatNumber(MEMORY_CAP)
  const capKb = MEMORY_CAP_BYTES / 1024
  const total = formatNumber(f.total)
  if (f.cut) {
    s += tail
      ? `(\`${rel}\` is ${total} characters, over the ${capText} (or ${capKb} KB) that are loaded: this is its end, and the start is left out.)\n\n`
      : `(\`${rel}\` is ${total} characters, over the ${capText} (or ${capKb} KB) that are loaded: the rest is ` +
        "cut off below. Make it shorter, moving details to other files.)\n\n"
  }
  return s + `<memory-file path="${rel}">\n${f.shown.trimEnd()}\n</memory-file>`
}

export const memory = (t: MemoryFacts): string => {
  const capText = formatNumber(MEMORY_CAP)
  let s =
    "\n\n## Your memory\n\n" +
    `You remember things between conversations by keeping them in files in your workspace (${t.dir}), which the board reads ` +
    "at the start of every run and puts below. When they change during a conversation (your own edits, the user's in " +
    `the Memory tab, a routine's), a later message starts with a \`<${UPDATE_TAG}>\` saying what they say now, which ` +
    "replaces what's below of them:\n" +
    `- \`${USER_FILE}\`: who the user is and their preferences.\n` +
    `- \`${MEMORY_FILE}\`: lasting facts, decisions and things to keep in mind.\n` +
    `- \`${LOG_DIR}/YYYY-MM-DD.md\`: a log for each day (today is ${t.today}, in the host's time zone). Today's and yesterday's are ` +
    "below; read older ones when you need them.\n" +
    `- \`${LOG_DIR}/<topic>.md\`: notes by topic, for what's too long or too seldom needed to keep in \`${MEMORY_FILE}\`. ` +
    "Only their paths, names and descriptions are below, not what they say. When the user's message names one of a " +
    `note's keywords, the board puts the note before the message, in a \`<${NOTES_TAG}>\`. When its topic comes up any ` +
    "other way (in your own work, a routine, or in words that aren't its keywords), read the note at its path before you " +
    "answer or act on it: don't go on its line below alone.\n\n" +
    `When the user tells you something worth remembering, or asks you to remember something, write it to \`${USER_FILE}\` ` +
    `(about them) or \`${MEMORY_FILE}\` (anything else) straight away, as a short line under a fitting heading: change a line ` +
    "that it updates rather than adding one that contradicts it. When they ask you to forget something, remove it from " +
    "these files and the daily logs, and say what you removed. Before you end a turn in which something worth keeping " +
    "happened, add a line or two to today's log (making it if it isn't there): what was asked, what you did, and " +
    `what's still pending. Keep \`${USER_FILE}\` and \`${MEMORY_FILE}\` under ${capText} characters each, since only that much of ` +
    "them is loaded: keep details in other files in the workspace and a line here that points to them. Don't keep " +
    "passwords, tokens or other secrets in your memory. To keep a topic as a note, start its file in " +
    `\`${LOG_DIR}/\` with frontmatter between \`---\` lines: \`name\`, a one-line \`description\` of what it's about, ` +
    "`keywords` (a list of words the user would use for it: whole words in any case, and `invoic*` for any word that " +
    `starts so) and a \`type\` (${NOTE_TYPES.map((n) => `\`${n}\``).join(", ")}) under \`metadata\`; a file there with no ` +
    "keywords isn't a note. The user can read and edit these files in the board's Memory tab. " +
    "After each of your turns the board keeps a history of the workspace, in a git repository of its own outside it: " +
    "the files that `.gitignore` lists and files over 1 MB are left out of it, so keep downloads and the like in a " +
    "folder it lists."
  for (const [rel, label, tail, missing, f] of files(t)) s += section(rel, label, tail, missing, f)
  return s + notesIndex(t.notes)
}

/** The notes' section: a line for each, with its path, type, name and description (HE-36). */
export const notesIndex = (notes: ReadonlyArray<Note>): string => {
  let s = "\n\n### Notes by topic\n\n"
  if (notes.length === 0) return s + `There are no notes by topic in \`${LOG_DIR}/\` yet.`
  s += "Read a note at its path when its topic comes up, unless it's in a `<" + NOTES_TAG + ">` already:"
  for (const n of notes) {
    const type = n.type === null ? "" : ` (${n.type})`
    s += `\n- \`${n.rel}\`${type}: ${n.name}${n.description === "" ? "" : ` — ${n.description}`}`
  }
  return s
}

/** A note put before a message: its body as the board read it, or cut (HE-36). */
export interface NoteLoaded {
  readonly note: Note
  readonly file: MemoryFile
}

/**
 * What a run is told of its notes before its message: the notes `loaded` (named by its message, or changed since its
 * conversation was told them), and the others its message named that aren't (past `MAX_NOTES_LOADED`). "" for none.
 */
export const notesBefore = (loaded: ReadonlyArray<NoteLoaded>, more: ReadonlyArray<Note>): string => {
  if (loaded.length === 0 && more.length === 0) return ""
  const capText = formatNumber(MEMORY_CAP)
  let body = ""
  for (const { note, file } of loaded) {
    body += `\n\n### ${note.name} (${note.rel})\n\n`
    if (file._tag !== "Shown") {
      body += `\`${note.rel}\` has nothing after its frontmatter.`
      continue
    }
    if (file.cut) body += `(\`${note.rel}\` is ${formatNumber(file.total)} characters, over the ${capText} that are loaded: read the file for the rest.)\n\n`
    body += `<memory-file path="${note.rel}">\n${file.shown.trimEnd()}\n</memory-file>`
  }
  if (more.length > 0)
    body += `\n\nThe message names notes that aren't loaded here too: ${more.map((n) => `\`${n.rel}\``).join(", ")}. Read them if you need them.`
  const intro =
    "Your notes by topic that this message names a keyword of (or that changed since you were shown them), as they are now, " +
    "which replace what you were shown of them before:"
  return `<${NOTES_TAG}>\n${intro}${body}\n</${NOTES_TAG}>\n\n`
}

/**
 * What a later run of a conversation is told before its message: all of `t` (`changes` null: the conversation may not
 * have what it was told, after a compaction, say, or it's another day), or the files `changes` names (by path) as they
 * changed, and the notes' list when `notesChanged`. "" when nothing did.
 */
export const memoryUpdate = (t: MemoryFacts, changes: ReadonlyMap<string, MemoryChange> | null, notesChanged = false): string => {
  let body = ""
  for (const [rel, label, tail, missing, f] of files(t)) {
    if (changes === null) {
      body += section(rel, label, tail, missing, f)
      continue
    }
    const c = changes.get(rel)
    if (c === undefined) continue
    body +=
      c._tag === "Whole"
        ? section(rel, label, tail, missing, c.file)
        : `\n\n### ${label}: added at its end\n\n<memory-file path="${rel}" part="end">\n${c.added.trimEnd()}\n</memory-file>`
  }
  if (changes === null || notesChanged) body += notesIndex(t.notes)
  if (body === "") return ""
  const intro =
    changes === null
      ? `Your memory files as they are now (today is ${t.today}, in the host's time zone), which replace what you were shown of them before:`
      : "Your memory files changed since you were last shown them. What changed, as they are now, which replaces what you were shown of them before:"
  return `<${UPDATE_TAG}>\n${intro}${body}\n</${UPDATE_TAG}>\n\n`
}

/** What the assistant is told when its memory can't be loaded (`reason`). */
export const memoryNotLoaded = (reason: string): string => `\n\n## Your memory\n\nYour memory isn't loaded: ${reason}. Tell the user, so they can fix it.`
