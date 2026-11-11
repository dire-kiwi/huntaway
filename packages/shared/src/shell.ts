// The reader of shell commands (docs/plan/06-server.md, Hook commands): which programs a command runs (`gh-hook` turns
// away `gh` in Bash) and whether it changes code (a task has something to review). From huntaway's git/changes.ts,
// itself a port of the Rust server's; the cases are its tests'. Plain TypeScript: the gh hook loads it for every Bash call.
//
// This reads commands, not what they did, so it can't see files a script writes from its own code (`python3 -c '...'`,
// a script file). That's accepted: such a task can still be reviewed with Review now, and treating every script as a
// change would review most tasks again.

/**
 * A shell token: a word (unquoted) or an operator. `Control` is a control operator (`;`, `&&`, `|`, `(`, newline, ...),
 * which ends a simple command. `Output` is an output redirect (`>`, `>>`, `2>`, `&>`): the next word is where it
 * writes. `Input` is an input redirect or here-document (`<`, `<<`, `<<<`): the next word is what it reads (a
 * here-document's delimiter). `HereDoc` is a here-document's body, data for the command it's given to (after the line
 * it starts on).
 */
export type Token =
  | { readonly t: "Word"; readonly w: string }
  | { readonly t: "Control" }
  | { readonly t: "Output" }
  | { readonly t: "Input" }
  | { readonly t: "HereDoc"; readonly body: string }

/** Rust's `char::is_whitespace` (Unicode White_Space). */
const isWs = (c: string | undefined) => c !== undefined && c !== "\uFEFF" && /^\s$/u.test(c)
const isAsciiDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9"

/** `char::to_digit(radix)`. */
const toDigit = (c: string | undefined, radix: number): number | null => {
  if (c === undefined || c.length !== 1) return null
  const code = c.charCodeAt(0)
  let d: number
  if (code >= 48 && code <= 57) d = code - 48
  else if (code >= 97 && code <= 122) d = code - 97 + 10
  else if (code >= 65 && code <= 90) d = code - 65 + 10
  else return null
  return d < radix ? d : null
}

/** Split a shell command into words and operators, removing quotes and escapes. */
export const tokenize = (command: string): Array<Token> => {
  const cs = Array.from(command)
  let i = 0
  const peek = () => cs[i]
  const next = (): string | undefined => (i < cs.length ? cs[i++] : undefined)
  const tokens: Array<Token> = []
  let word = ""
  // Whether there's a word in progress (it may be empty, as in `''`).
  let inWord = false
  // Here-documents started on the current line: the index of their `Input` token, and whether their body's leading
  // tabs are stripped (`<<-`).
  let heredocs: Array<readonly [number, boolean]> = []
  const endWord = () => {
    if (inWord) {
      tokens.push({ t: "Word", w: word })
      word = ""
      inWord = false
    }
  }
  for (let c = next(); c !== undefined; c = next()) {
    if (c === "'") {
      inWord = true
      for (let d = next(); d !== undefined; d = next()) {
        if (d === "'") break
        word += d
      }
    } else if (c === '"') {
      inWord = true
      for (let d = next(); d !== undefined; d = next()) {
        if (d === '"') break
        const n = peek()
        if (d === "\\" && n !== undefined && '"\\$`\n'.includes(n)) word += next() ?? ""
        else word += d
      }
    } else if (c === "\\") {
      inWord = true
      const n = next()
      if (n !== undefined && n !== "\n") word += n
    } else if (c === "#" && !inWord) {
      // A comment, to the end of the line.
      while (peek() !== undefined && peek() !== "\n") next()
    } else if (c === ">") {
      // `2>`, `&>`: the digits or `&` before it are the redirect's, not a word.
      if (inWord && (word === "&" || Array.from(word).every(isAsciiDigit))) {
        word = ""
        inWord = false
      }
      endWord()
      while (peek() === ">" || peek() === "|") next()
      if (peek() === "&") {
        // `>&2` duplicates a descriptor rather than writing a file.
        next()
        while (isAsciiDigit(peek()) || peek() === "-") next()
        continue
      }
      tokens.push({ t: "Output" })
    } else if (c === "<") {
      endWord()
      let n = 1
      while (peek() === "<") {
        next()
        n++
      }
      if (n === 2) {
        const stripTabs = peek() === "-"
        if (stripTabs) next()
        heredocs.push([tokens.length, stripTabs])
      }
      tokens.push({ t: "Input" })
    } else if (c === ";" || c === "&" || c === "|" || c === "(" || c === ")" || c === "\n") {
      if (c === "&" && peek() === ">") {
        endWord()
        word += "&"
        inWord = true
        continue
      }
      endWord()
      if (c === "\n") {
        // The bodies of the line's here-documents follow it, each up to its delimiter.
        const started = heredocs
        heredocs = []
        for (const [at, stripTabs] of started) {
          const d = tokens[at + 1]
          if (d === undefined || d.t !== "Word") continue
          const delimiter = d.w
          let body = ""
          while (peek() !== undefined) {
            let line = ""
            for (let x = next(); x !== undefined && x !== "\n"; x = next()) line += x
            if (stripTabs) line = line.replace(/^\t+/, "")
            if (line === delimiter) break
            body += line + "\n"
          }
          tokens.push({ t: "HereDoc", body })
        }
      }
      if (tokens.at(-1)?.t !== "Control") tokens.push({ t: "Control" })
    } else if (isWs(c)) {
      endWord()
    } else if (c === "$" && peek() === "'") {
      // `$'…'` is quoted with escapes (ANSI-C quoting), and `$"…"` is quoted like `"…"`.
      inWord = true
      next()
      const pos = { i }
      word += ansiCQuoted(cs, pos)
      i = pos.i
    } else if (c === "$" && peek() === '"') {
      inWord = true
    } else {
      inWord = true
      word += c
      // `$$` is a variable, so a quote after it isn't `$'…'` or `$"…"`.
      if (c === "$" && peek() === "$") word += next() ?? ""
    }
  }
  endWord()
  return tokens
}

/** The code of a simple escape (`\n`, `\\`) in ANSI-C quoting, if `e` is one. */
const SIMPLE_ESCAPES: Readonly<Record<string, number>> = { a: 7, b: 8, e: 27, E: 27, f: 12, n: 10, r: 13, t: 9, v: 11, "\\": 92, "'": 39, '"': 34, "?": 63 }

/**
 * The text of an ANSI-C quoted string (`$'…'`) after its opening quote, up to its closing one, with its escapes (`\'`,
 * `\x68`, `\150`, `\u0068`, `\n`, `\cA`, …) decoded as bash decodes them. Reads `chars` from `pos.i`, leaving it after
 * what was read.
 */
const ansiCQuoted = (chars: ReadonlyArray<string>, pos: { i: number }): string => {
  const peek = () => chars[pos.i]
  const next = (): string | undefined => (pos.i < chars.length ? chars[pos.i++] : undefined)
  let out = ""
  for (let c = next(); c !== undefined; c = next()) {
    if (c === "'") break
    if (c !== "\\") {
      out += c
      continue
    }
    const e = next()
    if (e === undefined) break
    const number = (radix: number, max: number, start: number | null): number | null => {
      let n = start
      for (let k = 0; k < max; k++) {
        const d = toDigit(peek(), radix)
        if (d === null) break
        next()
        n = (n ?? 0) * radix + d
      }
      return n
    }
    let code: number | null
    const simple = Object.hasOwn(SIMPLE_ESCAPES, e) ? SIMPLE_ESCAPES[e] : undefined
    if (simple !== undefined) code = simple
    else if (e === "x") code = number(16, 2, null)
    else if (e === "u") code = number(16, 4, null)
    else if (e === "U") code = number(16, 8, null)
    else if (e === "c") {
      const x = next()
      code = x === undefined ? null : ((x.length === 1 && x >= "a" && x <= "z" ? x.toUpperCase() : x).codePointAt(0) ?? 0) & 0x1f
    } else code = e >= "0" && e <= "7" ? number(8, 2, toDigit(e, 8)) : null
    if (code !== null) {
      // Not a char (a surrogate, or past U+10FFFF): the replacement character.
      out += code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? "\uFFFD" : String.fromCodePoint(code)
    } else {
      // Not an escape (`\q`, `\x` without digits): the backslash stays.
      out += "\\" + e
    }
  }
  // A NUL ends the string's text (bash's strings are C strings), though not its quotes.
  return out.split("\0")[0] ?? ""
}

/** Commands that run the command after them (with their options). */
const WRAPPERS = new Set(["sudo", "env", "builtin", "time", "nice", "nohup", "command", "exec", "timeout", "xargs", "stdbuf"])

/** A wrapper's options that take a value (`env -u NAME`, `timeout -s TERM`): its short ones, by letter, and its long ones. */
const valueOptions = (wrapper: string): readonly [string, ReadonlyArray<string>] => {
  switch (wrapper) {
    case "sudo":
      return ["ugCDhprtTU", ["--user", "--group", "--close-from", "--chdir", "--host", "--prompt", "--role", "--type", "--command-timeout", "--other-user"]]
    case "env":
      return ["uCS", ["--unset", "--chdir", "--split-string"]]
    case "time":
      return ["fo", ["--format", "--output"]]
    case "nice":
      return ["n", ["--adjustment"]]
    case "exec":
      return ["a", []]
    case "timeout":
      return ["sk", ["--signal", "--kill-after"]]
    case "xargs":
      return ["adEILnPs", ["--arg-file", "--delimiter", "--max-args", "--max-procs", "--max-chars", "--max-lines", "--process-slot-var"]]
    case "stdbuf":
      return ["ioe", ["--input", "--output", "--error"]]
    default:
      return ["", []]
  }
}

/**
 * A wrapper's option at `words[i]` (`-u`, `-Eu`, `-uroot`, `--user`, `--user=root`): how many words it takes up (two
 * when its value is the next word), and the option taking a value, with that value, if one does. In a cluster of short
 * options, the first one taking a value takes the rest of the word, or the next word if it's last.
 */
const wrapperOption = (wrapper: string, words: ReadonlyArray<string>, i: number): readonly [number, readonly [string, string] | null] => {
  const word = words[i] ?? ""
  const following = words[i + 1]
  const [short, long] = valueOptions(wrapper)
  if (word.startsWith("--")) {
    const eq = word.indexOf("=")
    if (eq >= 0) {
      const name = word.slice(0, eq)
      return long.includes(name) ? [1, [name, word.slice(eq + 1)]] : [1, null]
    }
    if (long.includes(word)) return [2, following !== undefined ? [word, following] : null]
    return [1, null]
  }
  const cluster = word.slice(1)
  let at = 0
  for (const c of cluster) {
    if (short.includes(c)) {
      const rest = cluster.slice(at + c.length)
      const option = `-${c}`
      return rest === "" ? [2, following !== undefined ? [option, following] : null] : [1, [option, rest]]
    }
    at += c.length
  }
  return [1, null]
}

/** Git subcommands that change a repository's files or history, or a remote's. */
const GIT_CHANGES = new Set(["commit", "push", "apply", "am", "cherry-pick", "merge", "rebase", "revert", "mv", "rm"])

/** The simple commands of a command, in order: each one's words (without redirects) and the here-documents it's given. */
interface Simple {
  readonly words: ReadonlyArray<string>
  readonly heredocs: ReadonlyArray<string>
}

/**
 * Whether a shell command changes code: a commit, a push, a new pull request, or a write (in-place edits, redirects,
 * copies and the like) anywhere but a scratch place such as /tmp. `depth` limits how deep `bash -c '...'` is followed.
 */
export const commandChangesCode = (command: string, depth = 0): boolean => {
  const tokens = tokenize(command)
  let words: Array<string> = []
  let heredocs: Array<string> = []
  let k = 0
  for (;;) {
    const t = tokens[k]
    k++
    if (t?.t === "Word") words.push(t.w)
    else if (t?.t === "HereDoc") heredocs.push(t.body)
    else if (t?.t === "Output") {
      const target = tokens[k]
      k++
      if (target?.t === "Word" && !scratch(target.w)) return true
    } else if (t?.t === "Input") {
      if (tokens[k]?.t === "Word") k++
    } else {
      // Control, or the end.
      if (simpleCommandChangesCode({ words, heredocs }, depth)) return true
      words = []
      heredocs = []
      if (k >= tokens.length) return false
    }
  }
}

/**
 * Whether a shell command runs `program` (by name, wherever it's installed) in any of its simple commands, including
 * command substitutions (`$(…)` and backticks, quoted or not), after reserved words (`if`, `!`, `do`, …) and wrappers
 * such as `env`, and in scripts given to a shell.
 */
export const runsProgram = (command: string, program: string): boolean => runs(command, program, 0)

/** Reserved words that can come before a simple command's program. */
const RESERVED = new Set(["if", "then", "else", "elif", "while", "until", "do", "!", "{"])

const runs = (command: string, program: string, depth: number): boolean => {
  const found = substitutions(command)
  // A substitution that never ends is a syntax error to bash, but one it may read differently (where its end is hard
  // to tell): it doesn't pass.
  if (found.unclosed || (depth < 3 && found.bodies.some((body) => runs(body, program, depth + 1)))) return true
  const tokens = tokenize(command)
  let words: Array<string> = []
  let heredocs: Array<string> = []
  let k = 0
  for (;;) {
    const t = tokens[k]
    k++
    if (t?.t === "Word") words.push(t.w)
    else if (t?.t === "HereDoc") heredocs.push(t.body)
    else if (t?.t === "Output" || t?.t === "Input") {
      if (tokens[k]?.t === "Word") k++
    } else {
      const split: Array<string> = []
      const i = commandIndex(words, split)
      if (depth < 3 && split.some((script) => runs(script, program, depth + 1))) return true
      const at = words[i]
      const name = at !== undefined ? basename(at) : null
      const args = words.slice(i + 1)
      let ran = false
      if (name !== null && name === program) ran = true
      else if ((name === "bash" || name === "sh" || name === "zsh") && depth < 3) {
        ran = shellScripts(args, heredocs).some((script) => runs(script, program, depth + 1))
      } else if (name === "eval" && depth < 3) {
        // `eval` runs its arguments, joined, as a script.
        ran = runs(args.join(" "), program, depth + 1)
      }
      if (ran) return true
      words = []
      heredocs = []
      if (k >= tokens.length) return false
    }
  }
}

/** What `substitutions` finds: the commands in them, and whether one never ends. */
export interface Found {
  readonly bodies: Array<string>
  unclosed: boolean
}

/**
 * The commands in a shell command's substitutions, `$(…)` and `` `…` ``, where bash expands them: outside single quotes
 * (double quotes don't stop them) and comments, and in here-documents whose delimiter isn't quoted. A substitution's
 * own text is read the same way, so its end is the `)` bash would end it at, not one in quotes, a comment or a
 * here-document.
 */
export const substitutions = (command: string): Found => {
  const chars = Array.from(command)
  const out: Found = { bodies: [], unclosed: false }
  scanSubstitutions(chars, { i: 0 }, "Script", out)
  return out
}

/**
 * What `scanSubstitutions` reads: `Script` is shell code, to its end; `Substitution` the inside of a `$(`, up to the
 * `)` that closes it; `HereDoc` an expanded here-document's body, where quotes and `#` are only text.
 */
type Scan = "Script" | "Substitution" | "HereDoc"

/** Reserved words and prefixes after which a command can start. */
const PREFIXES = new Set([...RESERVED, "then", "do", "else", "elif", "!", "time", "coproc"])

/** Whether `c` ends a word: whitespace or an operator's character. */
const separator = (c: string | undefined) => c !== undefined && (isWs(c) || ";&|()<>".includes(c))

/**
 * Read `chars` from `pos.i`, adding the substitutions found to `out`, and leave `pos.i` after what was read (after the
 * closing `)` for a `Substitution`).
 */
const scanSubstitutions = (chars: ReadonlyArray<string>, pos: { i: number }, scan: Scan, out: Found): void => {
  let double = false
  // Parentheses opened inside a substitution (subshells, `$((…))`), which its `)` isn't.
  let depth = 0
  // Whether the next character starts a word (where `#` starts a comment).
  let wordStart = true
  // Here-documents started on the current line: their delimiter, whether their body is expanded (the delimiter isn't
  // quoted), and whether their lines' leading tabs are stripped.
  let heredocs: Array<readonly [string, boolean, boolean]> = []
  // The word being read, unquoted (quotes make it no keyword), and whether it's where a command starts, to follow
  // `case … in … esac`: for each case open, whether its `in` has come; and whether a pattern is being read, whose `)`
  // doesn't close anything.
  let word = ""
  let atCommand = true
  const cases: Array<boolean> = []
  let pattern = false
  // Whether the word being read is a pattern's first (where `esac` is the keyword, not after `|`), and whether the
  // last word was `time` (whose options a command can follow too).
  let patternFirst = false
  let afterTime = false
  // As Rust's: the position moves on even past the end.
  const next = (): string | undefined => {
    const c = chars[pos.i]
    pos.i++
    return c
  }
  const at = (k: number): string | undefined => chars[k]
  for (let c = next(); c !== undefined; c = next()) {
    let startsWord = false
    if (!double && separator(c)) {
      const w = word
      word = ""
      if (w === "case" && atCommand && !pattern) cases.push(false)
      else if (w === "in" && cases.length > 0 && cases.at(-1) === false) {
        cases.pop()
        cases.push(true)
        pattern = true
        patternFirst = true
      } else if (w === "esac" && cases.length > 0 && (pattern ? patternFirst : atCommand)) {
        // As an argument, or a pattern's after `|`, it's just a word.
        cases.pop()
        pattern = false
      }
      if (w !== "") {
        // A command can follow a reserved word or prefix only where that word started one: as an argument
        // (`echo do`), it's just a word.
        const prefix = PREFIXES.has(w)
        const timeOption: boolean = afterTime && w.startsWith("-")
        afterTime = atCommand && (w === "time" || timeOption)
        atCommand = atCommand && (prefix || timeOption)
        patternFirst = false
      }
      // In a pattern, `|` separates its alternatives.
      if (c === "\n" || ";&()".includes(c) || (c === "|" && !pattern)) atCommand = true
    }
    if (c === "\\") {
      word += c
      pos.i++
    } else if (c === "$" && at(pos.i) === "$") {
      // `$$` is a variable, not the start of `$(` or `$'`.
      word += "$$"
      pos.i++
    } else if (c === "$" && at(pos.i) === "(") {
      word += c
      pos.i++
      const start = pos.i
      scanSubstitutions(chars, pos, "Substitution", out)
      const end = Math.min(Math.max(pos.i - 1, start), chars.length)
      const body = chars.slice(start, end).join("")
      // `case` syntax is the easiest to misread where a substitution ends, so with what may be one in it (`case` and
      // `esac`), the rest of the command is read as part of it too.
      const words = body.split(/[^A-Za-z0-9_]/)
      if (words.includes("case") && words.includes("esac")) out.bodies.push(chars.slice(Math.min(start, chars.length)).join(""))
      out.bodies.push(body)
    } else if (c === "`") {
      word += c
      let body = ""
      let closed = false
      for (let d = next(); d !== undefined; d = next()) {
        if (d === "`") {
          closed = true
          break
        }
        if (d === "\\") body += next() ?? ""
        else body += d
      }
      out.unclosed ||= !closed
      out.bodies.push(body)
    } else if (scan === "HereDoc") {
      // Quotes, comments and the rest are only text in a here-document.
    } else if (c === "$" && !double && at(pos.i) === "'") {
      // `$'…'` may have escaped quotes (`\'`) in it.
      word += "$'"
      pos.i++
      ansiCAt(chars, pos)
    } else if (c === "'" && !double) {
      word += c
      for (let d = next(); d !== undefined && d !== "'"; d = next()) {
        // Skipped: single quotes hold no substitutions.
      }
    } else if (c === '"') {
      word += c
      double = !double
    } else if (c === "#" && !double && wordStart) {
      while (at(pos.i) !== undefined && at(pos.i) !== "\n") pos.i++
    } else if (c === "(" && !double && scan === "Substitution") {
      // A pattern may start with `(` too.
      if (!pattern) depth++
      startsWord = true
    } else if (c === ")" && !double && scan === "Substitution") {
      if (pattern) pattern = false
      else if (depth === 0) return
      else depth--
      startsWord = true
    } else if (c === "<" && !double && at(pos.i) === "<") {
      pos.i++
      // `<<<` is a here-string, a word like any other.
      if (at(pos.i) === "<") pos.i++
      else {
        const stripTabs = at(pos.i) === "-"
        if (stripTabs) pos.i++
        while (at(pos.i) === " " || at(pos.i) === "\t") pos.i++
        // The delimiter is a word, quotes removed: quoted, it may have spaces in it.
        let delimiter = ""
        let quoted = false
        for (let n = at(pos.i); n !== undefined && !separator(n); n = at(pos.i)) {
          pos.i++
          if (n === "$" && at(pos.i) === "'") {
            quoted = true
            pos.i++
            delimiter += ansiCAt(chars, pos)
          } else if (n === "$" && at(pos.i) === '"') {
            // `$"…"` is quoted like `"…"`.
          } else if (n === "'") {
            quoted = true
            for (let d = next(); d !== undefined && d !== "'"; d = next()) delimiter += d
          } else if (n === '"') {
            quoted = true
            for (let d = next(); d !== undefined && d !== '"'; d = next()) {
              if (d === "\\") delimiter += next() ?? ""
              else delimiter += d
            }
          } else if (n === "\\") {
            quoted = true
            delimiter += next() ?? ""
          } else delimiter += n
        }
        heredocs.push([delimiter, !quoted, stripTabs])
      }
    } else if (c === "\n" && !double) {
      // The bodies of the line's here-documents follow it, each up to its delimiter.
      const started = heredocs
      heredocs = []
      for (const [delimiter, expanded, stripTabs] of started) {
        const body: Array<string> = []
        while (pos.i < chars.length) {
          let end = chars.indexOf("\n", pos.i)
          if (end < 0) end = chars.length
          const line = chars.slice(pos.i, end).join("")
          pos.i = end + 1
          if ((stripTabs ? line.replace(/^\t+/, "") : line) === delimiter) break
          body.push(...Array.from(line), "\n")
        }
        if (expanded) scanSubstitutions(body, { i: 0 }, "HereDoc", out)
      }
      startsWord = true
    } else if (!double && (isWs(c) || ";&|".includes(c))) {
      // `;;`, `;&` and `;;&` end a case's command list: a pattern comes next.
      if (c === ";" && (at(pos.i) === ";" || at(pos.i) === "&") && cases.at(-1) === true) {
        pattern = true
        patternFirst = true
      }
      startsWord = true
    } else if (!double) {
      word += c
    }
    wordStart = startsWord
  }
  // The input ended before the substitution's `)`.
  if (scan === "Substitution") out.unclosed = true
}

/** `ansiCQuoted` on `chars` from `pos.i`, leaving `pos.i` after the closing quote. */
const ansiCAt = (chars: ReadonlyArray<string>, pos: { i: number }): string => {
  const p = { i: Math.min(pos.i, chars.length) }
  const text = ansiCQuoted(chars, p)
  pos.i = p.i
  return text
}

/**
 * Where the program is in a simple command's words as bash runs them: after reserved words, pipeline prefixes
 * (`time [-p]`, `!`, `coproc`), variable assignments and wrappers, in any order (`time ! gh`, `env X=1 gh`). See
 * `programIndex` for `split`.
 */
const commandIndex = (words: ReadonlyArray<string>, split: Array<string>): number => {
  let i = 0
  for (;;) {
    const before = i
    for (let w = words[i]; w !== undefined; w = words[i]) {
      if (RESERVED.has(w) || w === "coproc") i++
      else if (w === "time") {
        i++
        while (words[i] === "-p" || words[i] === "--") i++
      } else break
    }
    i += programIndex(words.slice(i), split)
    if (i === before) return i
  }
}

/**
 * Where the program is in a simple command's words: after variable assignments and wrappers such as `timeout 900`. The
 * commands `env -S` is given to split are added to `split`.
 */
const programIndex = (words: ReadonlyArray<string>, split: Array<string>): number => {
  let i = 0
  for (let w = words[i]; w !== undefined; w = words[i]) {
    const eq = w.indexOf("=")
    const assignment = eq > 0 && /^[A-Za-z0-9_]+$/.test(w.slice(0, eq))
    if (assignment) i++
    else if (WRAPPERS.has(basename(w))) {
      const wrapper = basename(w)
      i++
      // Its options (and their values), and the durations, priorities and assignments some take.
      for (let o = words[i]; o !== undefined; o = words[i]) {
        if (o === "--") {
          i++
          break
        } else if (o.startsWith("-") && o.length > 1) {
          const [taken, value] = wrapperOption(wrapper, words, i)
          if (wrapper === "env" && value !== null) {
            const [option, command] = value
            if (option === "-S" || option === "--split-string") split.push(`env ${command}`)
          }
          // An option missing its value (`env -u`) takes up what's left.
          i = Math.min(i + taken, words.length)
        } else if (isAsciiDigit(o[0]) || o.includes("=")) i++
        else break
      }
    } else break
  }
  return i
}

/**
 * Whether one simple command (its words, without redirects, and the here-documents it's given) changes code. A
 * here-document is only read as a script when it's given to a shell.
 */
const simpleCommandChangesCode = ({ words, heredocs }: Simple, depth: number): boolean => {
  const i = programIndex(words, [])
  const at = words[i]
  if (at === undefined) return false
  const name = basename(at)
  const args = words.slice(i + 1)
  const operands = () => args.filter((a) => !a.startsWith("-"))
  switch (name) {
    case "git":
      return GIT_CHANGES.has(gitSubcommand(args))
    case "gh":
      return args[0] === "pr" && args[1] === "create"
    case "sed":
    case "perl":
      return args.some((a) => a.startsWith("--in-place") || (a.startsWith("-") && !a.startsWith("--") && inPlaceFlag(a)))
    case "patch":
      return true
    case "tee":
    case "touch":
    case "rm":
    case "rmdir":
    case "mkdir":
    case "truncate":
      return operands().some((a) => !scratch(a))
    case "cp":
    case "mv":
    case "install":
    case "ln":
    case "rsync": {
      const last = operands().at(-1)
      return last !== undefined && !scratch(last)
    }
    case "bash":
    case "sh":
    case "zsh":
      return depth < 3 && shellScripts(args, heredocs).some((script) => commandChangesCode(script, depth + 1))
    default:
      return false
  }
}

/** The scripts a shell runs, given its arguments and here-documents: its `-c` script, or else what it reads from a here-document. */
const shellScripts = (args: ReadonlyArray<string>, heredocs: ReadonlyArray<string>): ReadonlyArray<string> => {
  const p = args.findIndex((a) => a.startsWith("-") && !a.startsWith("--") && a.includes("c"))
  if (p < 0) return heredocs
  const script = args[p + 1]
  return script !== undefined ? [script] : []
}

/** Whether a short-option cluster for sed or perl edits in place: `-i`, `-i.bak`, `-pi`, `-Ei`. */
const inPlaceFlag = (arg: string): boolean => (/^[A-Za-z]*/.exec(arg.slice(1))?.[0] ?? "").includes("i")

const basename = (word: string): string => {
  const k = word.lastIndexOf("/")
  return k < 0 ? word : word.slice(k + 1)
}

/** Whether a path is a scratch place whose writes aren't code changes. */
const scratch = (path: string): boolean => ["/dev/", "/tmp/", "/var/tmp/", "$TMPDIR", "${TMPDIR"].some((p) => path.startsWith(p)) || path === "/tmp"

/** The subcommand in a git command's arguments, after its options (such as `-C <dir>`). */
const gitSubcommand = (args: ReadonlyArray<string>): string => {
  let i = 0
  for (let a = args[i]; a !== undefined; a = args[i]) {
    if (a === "-C" || a === "-c" || a === "--git-dir" || a === "--work-tree" || a === "--namespace") i += 2
    else if (a.startsWith("-")) i++
    else return a
  }
  return ""
}
