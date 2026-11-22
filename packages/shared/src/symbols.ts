// HE-79: the Code tab's symbols, found by search as GitHub's search-based code navigation does: a name's uses are the
// lines a word search (`git grep -w`) finds, and the ones that define it are those a definition pattern below matches
// (`function N`, `class N`, `def N`, `fn N`, a method's `N(…) {`, a top-level `N = …`, a C function's `int N(…)`…).
// They know no scopes and no types, so a local `const x` is a definition of every `x`, and a call that looks like a
// definition is taken for one; what they gain is that they need no index, no parser and no grammar per language. Used
// by the server (which of `git.symbol`'s hits define the name) and the web app (a file's outline, the word clicked).

/** A name a symbol can have: letters, digits, `_` and `$`, not starting with a digit. */
const NAME = "[\\p{L}_$][\\p{L}\\p{N}_$]*"
const NAME_RE = new RegExp(`^${NAME}$`, "u")
/** Not a name's character, on either side of it. */
const BEFORE = "(?<![\\p{L}\\p{N}_$])"
const AFTER = "(?![\\p{L}\\p{N}_$])"
const WORD_CHAR = /[\p{L}\p{N}_$]/u

/** Longer names than this aren't looked up. */
export const MAX_SYMBOL_LENGTH = 200

/** Words that are languages' own, not symbols: clicking one looks nothing up, and none is in an outline. */
export const KEYWORDS: ReadonlySet<string> = new Set(
  (
    "if else elif elsif for foreach while do switch case default break continue return yield await async new delete typeof " +
    "instanceof in of is as not and or try catch except finally throw throws raise with function func fn def fun class " +
    "struct enum interface trait impl type let const var val static public private protected internal readonly abstract " +
    "override virtual final extends implements import export from package use using namespace module mod pub mut self " +
    "this super true false null nil None True False undefined void unsafe extern inline sizeof goto lambda pass match " +
    "end then begin defer go chan select where loop unless until when sub proc echo print require include " +
    "int char float double long short unsigned signed bool auto register volatile"
  ).split(" "),
)

/** Whether `s` is a name worth looking up: a name's characters, not too long, and not a keyword. */
export const isSymbolName = (s: string): boolean => s.length > 0 && s.length <= MAX_SYMBOL_LENGTH && NAME_RE.test(s) && !KEYWORDS.has(s)

/** The symbol name `offset` (a character of `line`) is in, and where it starts; null for one that isn't (a keyword too). */
export function wordAt(line: string, offset: number): { readonly name: string; readonly start: number } | null {
  let start = Math.min(Math.max(offset, 0), line.length)
  let end = start
  while (start > 0 && WORD_CHAR.test(line[start - 1] ?? "")) start--
  while (end < line.length && WORD_CHAR.test(line[end] ?? "")) end++
  const name = line.slice(start, end)
  return isSymbolName(name) ? { name, start } : null
}

/** Where `name` is in `line` as a whole word (each start); `name` is a symbol name. */
export function occurrences(line: string, name: string): Array<number> {
  const re = new RegExp(`${BEFORE}${escape(name)}${AFTER}`, "gu")
  return [...line.matchAll(re)].map((m) => m.index)
}

const escape = (name: string) => name.replace(/\$/g, "\\$")

// A definition's keyword, then the name: `function`, `class`, `def`, `fn`, `type`, `const`, `let`… (Rust's `let mut`,
// Ruby's `def self.`), or C's `#define`.
const LEADS =
  "function\\*?|class|interface|type|enum|namespace|module|struct|trait|union|def|fn|func|fun|object|record|protocol|typealias|" +
  "macro_rules!|defmodule|defp|defmacro|sub|proc|mod|let|const|var|val|#\\s*define"
// What may come before a method's or field's name.
const MODIFIERS =
  "public|private|protected|internal|static|async|readonly|override|abstract|virtual|final|get|set|export|default|declare|unsafe|extern|inline|pub(?:\\([^)]*\\))?"
// The words a C-like statement starts with: never a function's type.
const STATEMENTS = "return|new|throw|else|await|yield|case|if|while|for|switch|catch|sizeof|delete|typeof|goto|do|echo|print|not|and|or|in|of"
/** C, C++, Objective-C, Java, C#: functions are their type, then their name. */
const C_LIKE = new Set(["c", "h", "cc", "cpp", "cxx", "hpp", "hh", "hxx", "m", "mm", "java", "cs", "ino", "cu"])
/** Lines that bring a name in from elsewhere rather than define it. */
const IMPORT = /^\s*(?:import|from|use|using|#\s*include|require|package|export\s*\{|export\s+\*|export\s+type\s*\{)(?![\p{L}\p{N}_$])/u

/** Lines that are comments (but C's `#define`, `#if`…): what they name isn't defined there. */
const COMMENT = /^\s*(?:\/\/|\/\*|\*|--|;|#(?!\s*define\b))/u

interface Pattern {
  /** `@N` stands for the name. */
  readonly re: string
  /** The files (by extension) it's for; every file when absent. */
  readonly ext?: ReadonlySet<string>
  /** Only on a line that isn't indented, in an outline (a function's locals aren't the file's symbols). */
  readonly outlineTop?: boolean
}

const PATTERNS: ReadonlyArray<Pattern> = [
  // `function N`, `class N`, `def N`, `fn N`, `type N`, `let mut N`, `def self.N`, `#define N`…
  { re: `${BEFORE}(?:${LEADS})\\s+(?:mut\\s+|self\\.)?@N${AFTER}` },
  // Go's methods: `func (r *T) N(`.
  { re: `^\\s*func\\s*\\([^)]*\\)\\s*@N\\s*[\\[(]` },
  // A method: `N(…) {`, `async N<T>(a: A): B {`, with the parameters closed on the line (a call with a callback, `N(() => {`, isn't).
  { re: `^\\s*(?:(?:${MODIFIERS})\\s+)*\\*?@N\\s*(?:<[^>]*>)?\\s*\\((?:[^()]|\\([^()]*\\))*\\)\\s*(?::\\s*[^=;{}]+)?\\{\\s*$` },
  // A top-level assignment: Python's and the shell's globals, Make's variables.
  { re: `^@N\\s*(?::[^=]*)?[:?]?=(?!=)` },
  // A field with a modifier: `readonly N: …`, `private N = …`.
  { re: `^\\s*(?:(?:${MODIFIERS})\\s+)+@N\\s*[?!]?\\s*[:=]` },
  // C's (and Java's, C#'s) functions: `static int N(…`, `void Foo::N(…`, not a statement and not a prototype (`;`).
  {
    re: `^\\s*(?!(?:${STATEMENTS})${AFTER})(?:[\\p{L}\\p{N}_$:<>\\[\\],.*&?]+\\s+)+[*&]*(?:[\\p{L}\\p{N}_]+::)*@N\\s*\\([^;]*$`,
    ext: C_LIKE,
    outlineTop: true,
  },
]

const extOf = (path: string) => {
  const name = path.slice(path.lastIndexOf("/") + 1)
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ""
}

const forFile = (path: string) => {
  const ext = extOf(path)
  return PATTERNS.filter((p) => !p.ext || p.ext.has(ext))
}

/** Whether `line` (of the file at `path`) defines `name`, a symbol name. */
export function definesName(line: string, name: string, path: string): boolean {
  if (IMPORT.test(line) || COMMENT.test(line)) return false
  const n = escape(name)
  return forFile(path).some((p) => new RegExp(p.re.replace("@N", n), "u").test(line))
}

/** A name a file defines: on which line (from 1), and how far in its line is (its indent, in characters). */
export interface OutlineEntry {
  readonly name: string
  readonly line: number
  readonly depth: number
}

/** Files with more lines than this have no outline. */
export const MAX_OUTLINE_LINES = 50_000

/** The names a file defines, in order (a file's outline): the definition patterns with any name. */
export function outline(text: string, path: string): Array<OutlineEntry> {
  const lines = text.split("\n")
  if (lines.length > MAX_OUTLINE_LINES) return []
  const patterns = forFile(path).map((p) => ({ outlineTop: p.outlineTop === true, regex: new RegExp(p.re.replace("@N", `(${NAME})`), "u") }))
  const out: Array<OutlineEntry> = []
  lines.forEach((line, i) => {
    if (line.length > 1000 || IMPORT.test(line) || COMMENT.test(line)) return
    const depth = line.length - line.trimStart().length
    for (const p of patterns) {
      if (p.outlineTop && depth > 0) continue
      const m = p.regex.exec(line)
      const name = m?.[1]
      if (name === undefined || !isSymbolName(name)) continue
      // A function's locals aren't the file's: `let`, `const`, `var` and `val` count at the top only.
      if (depth > 0 && /^\s*(?:export\s+)?(?:let|const|var|val)\s/u.test(line)) break
      out.push({ name, line: i + 1, depth })
      break
    }
  })
  return out
}
