// Port of server/src/git/changes.rs.
//
// Whether an agent's tool call changed code, so its task has something to review. Edits count, and so do shell commands
// that commit, push, open a pull request or write files (in-place edits, redirects, copies and the like), except to
// scratch places such as /tmp.
//
// This reads commands, not what they did, so it can't see files a script writes from its own code (`python3 -c '...'`,
// a script file). That's accepted: such a task can still be reviewed with Review now, and treating every script as a
// change would review most tasks again.
import * as permissions from "../mcp/permissions.ts";

/**
 * Whether a tool call, given its result (`tool_result` block) if it has one, changed code. An edit is all or nothing,
 * so it only did if it succeeded. A shell command may have written files before it failed or was cut short, so it did
 * unless it was denied and never ran.
 */
export function changes_code(tool_use: any, result: any | null | undefined): boolean {
  const name = typeof tool_use?.name === "string" ? tool_use.name : "";
  switch (name) {
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
    case "ApplyPatch":
      return result != null && result.is_error !== true;
    case "Bash": {
      const command = tool_use?.input?.command;
      return !(result != null && denied(result)) && command_changes_code(typeof command === "string" ? command : "", 0);
    }
    default:
      return false;
  }
}

/** Whether a tool call's result says it was denied, so it never ran. */
function denied(result: any): boolean {
  const DENIALS = ["The command was declined.", "The user denied this action.", permissions.DONT_ASK_DENIAL];
  const content = result?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((p: any) => typeof p?.text === "string")
            .map((p: any) => p.text)
            .join("\n")
        : "";
  return result?.is_error === true && DENIALS.some((d) => text.includes(d));
}

/**
 * A shell token: a word (unquoted) or an operator. `Control` is a control operator (`;`, `&&`, `|`, `(`, newline, ...),
 * which ends a simple command. `Output` is an output redirect (`>`, `>>`, `2>`, `&>`): the next word is where it
 * writes. `Input` is an input redirect or here-document (`<`, `<<`, `<<<`): the next word is what it reads (a
 * here-document's delimiter). `HereDoc` is a here-document's body, data for the command it's given to (after the line
 * it starts on).
 */
export type Token = { t: "Word"; w: string } | { t: "Control" } | { t: "Output" } | { t: "Input" } | { t: "HereDoc"; body: string };

/** Rust's `char::is_whitespace` (Unicode White_Space). */
const is_ws = (c: string | undefined) => c !== undefined && c !== "\uFEFF" && /^\s$/u.test(c);
const is_ascii_digit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";

/** `char::to_digit(radix)`. */
function to_digit(c: string | undefined, radix: number): number | null {
  if (c === undefined || c.length !== 1) return null;
  const code = c.charCodeAt(0);
  let d: number;
  if (code >= 48 && code <= 57) d = code - 48;
  else if (code >= 97 && code <= 122) d = code - 97 + 10;
  else if (code >= 65 && code <= 90) d = code - 65 + 10;
  else return null;
  return d < radix ? d : null;
}

/** Split a shell command into words and operators, removing quotes and escapes. */
export function tokenize(command: string): Token[] {
  const cs = Array.from(command);
  let i = 0;
  const peek = () => cs[i];
  const next = (): string | undefined => (i < cs.length ? cs[i++] : undefined);
  const tokens: Token[] = [];
  let word = "";
  // Whether there's a word in progress (it may be empty, as in `''`).
  let in_word = false;
  // Here-documents started on the current line: the index of their `Input` token, and whether their body's leading
  // tabs are stripped (`<<-`).
  let heredocs: Array<[number, boolean]> = [];
  const end_word = () => {
    if (in_word) {
      tokens.push({ t: "Word", w: word });
      word = "";
      in_word = false;
    }
  };
  for (let c = next(); c !== undefined; c = next()) {
    if (c === "'") {
      in_word = true;
      for (let d = next(); d !== undefined; d = next()) {
        if (d === "'") break;
        word += d;
      }
    } else if (c === '"') {
      in_word = true;
      for (let d = next(); d !== undefined; d = next()) {
        if (d === '"') break;
        if (d === "\\" && peek() !== undefined && '"\\$`\n'.includes(peek()!)) word += next();
        else word += d;
      }
    } else if (c === "\\") {
      in_word = true;
      const n = next();
      if (n !== undefined && n !== "\n") word += n;
    } else if (c === "#" && !in_word) {
      // A comment, to the end of the line.
      while (peek() !== undefined && peek() !== "\n") next();
    } else if (c === ">") {
      // `2>`, `&>`: the digits or `&` before it are the redirect's, not a word.
      if (in_word && (word === "&" || Array.from(word).every(is_ascii_digit))) {
        word = "";
        in_word = false;
      }
      end_word();
      while (peek() === ">" || peek() === "|") next();
      if (peek() === "&") {
        // `>&2` duplicates a descriptor rather than writing a file.
        next();
        while (is_ascii_digit(peek()) || peek() === "-") next();
        continue;
      }
      tokens.push({ t: "Output" });
    } else if (c === "<") {
      end_word();
      let n = 1;
      while (peek() === "<") {
        next();
        n++;
      }
      if (n === 2) {
        const strip_tabs = peek() === "-";
        if (strip_tabs) next();
        heredocs.push([tokens.length, strip_tabs]);
      }
      tokens.push({ t: "Input" });
    } else if (c === ";" || c === "&" || c === "|" || c === "(" || c === ")" || c === "\n") {
      if (c === "&" && peek() === ">") {
        end_word();
        word += "&";
        in_word = true;
        continue;
      }
      end_word();
      if (c === "\n") {
        // The bodies of the line's here-documents follow it, each up to its delimiter.
        const started = heredocs;
        heredocs = [];
        for (const [at, strip_tabs] of started) {
          const d = tokens[at + 1];
          if (!d || d.t !== "Word") continue;
          const delimiter = d.w;
          let body = "";
          while (peek() !== undefined) {
            let line = "";
            for (let x = next(); x !== undefined && x !== "\n"; x = next()) line += x;
            if (strip_tabs) line = line.replace(/^\t+/, "");
            if (line === delimiter) break;
            body += line + "\n";
          }
          tokens.push({ t: "HereDoc", body });
        }
      }
      if (tokens.at(-1)?.t !== "Control") tokens.push({ t: "Control" });
    } else if (is_ws(c)) {
      end_word();
    } else if (c === "$" && peek() === "'") {
      // `$'…'` is quoted with escapes (ANSI-C quoting), and `$"…"` is quoted like `"…"`.
      in_word = true;
      next();
      const pos = { i };
      word += ansi_c_quoted(cs, pos);
      i = pos.i;
    } else if (c === "$" && peek() === '"') {
      in_word = true;
    } else {
      in_word = true;
      word += c;
      // `$$` is a variable, so a quote after it isn't `$'…'` or `$"…"`.
      if (c === "$" && peek() === "$") word += next();
    }
  }
  end_word();
  return tokens;
}

/**
 * The text of an ANSI-C quoted string (`$'…'`) after its opening quote, up to its closing one, with its escapes (`\'`,
 * `\x68`, `\150`, `\u0068`, `\n`, `\cA`, …) decoded as bash decodes them. Reads `chars` from `pos.i`, leaving it after
 * what was read.
 */
function ansi_c_quoted(chars: string[], pos: { i: number }): string {
  const peek = () => chars[pos.i];
  const next = (): string | undefined => (pos.i < chars.length ? chars[pos.i++] : undefined);
  let out = "";
  for (let c = next(); c !== undefined; c = next()) {
    if (c === "'") break;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const e = next();
    if (e === undefined) break;
    const number = (radix: number, max: number, n: number | null): number | null => {
      for (let k = 0; k < max; k++) {
        const d = to_digit(peek(), radix);
        if (d === null) break;
        next();
        n = (n ?? 0) * radix + d;
      }
      return n;
    };
    let code: number | null;
    switch (e) {
      case "a":
        code = 7;
        break;
      case "b":
        code = 8;
        break;
      case "e":
      case "E":
        code = 27;
        break;
      case "f":
        code = 12;
        break;
      case "n":
        code = 10;
        break;
      case "r":
        code = 13;
        break;
      case "t":
        code = 9;
        break;
      case "v":
        code = 11;
        break;
      case "\\":
      case "'":
      case '"':
      case "?":
        code = e.codePointAt(0)!;
        break;
      case "x":
        code = number(16, 2, null);
        break;
      case "u":
        code = number(16, 4, null);
        break;
      case "U":
        code = number(16, 8, null);
        break;
      case "c": {
        const x = next();
        code = x === undefined ? null : (x.length === 1 && x >= "a" && x <= "z" ? x.toUpperCase() : x).codePointAt(0)! & 0x1f;
        break;
      }
      default:
        code = e >= "0" && e <= "7" ? number(8, 2, to_digit(e, 8)) : null;
    }
    if (code !== null) {
      // Not a char (a surrogate, or past U+10FFFF): the replacement character.
      out += code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? "\uFFFD" : String.fromCodePoint(code);
    } else {
      // Not an escape (`\q`, `\x` without digits): the backslash stays.
      out += "\\" + e;
    }
  }
  // A NUL ends the string's text (bash's strings are C strings), though not its quotes.
  return out.split("\0")[0];
}

/** Commands that run the command after them (with their options). */
const WRAPPERS = ["sudo", "env", "builtin", "time", "nice", "nohup", "command", "exec", "timeout", "xargs", "stdbuf"];

/** A wrapper's options that take a value (`env -u NAME`, `timeout -s TERM`): its short ones, by letter, and its long ones. */
function value_options(wrapper: string): [string, string[]] {
  switch (wrapper) {
    case "sudo":
      return ["ugCDhprtTU", ["--user", "--group", "--close-from", "--chdir", "--host", "--prompt", "--role", "--type", "--command-timeout", "--other-user"]];
    case "env":
      return ["uCS", ["--unset", "--chdir", "--split-string"]];
    case "time":
      return ["fo", ["--format", "--output"]];
    case "nice":
      return ["n", ["--adjustment"]];
    case "exec":
      return ["a", []];
    case "timeout":
      return ["sk", ["--signal", "--kill-after"]];
    case "xargs":
      return ["adEILnPs", ["--arg-file", "--delimiter", "--max-args", "--max-procs", "--max-chars", "--max-lines", "--process-slot-var"]];
    case "stdbuf":
      return ["ioe", ["--input", "--output", "--error"]];
    default:
      return ["", []];
  }
}

/**
 * A wrapper's option at `words[i]` (`-u`, `-Eu`, `-uroot`, `--user`, `--user=root`): how many words it takes up (two
 * when its value is the next word), and the option taking a value, with that value, if one does. In a cluster of short
 * options, the first one taking a value takes the rest of the word, or the next word if it's last.
 */
function wrapper_option(wrapper: string, words: string[], i: number): [number, [string, string] | null] {
  const word = words[i];
  const [short, long] = value_options(wrapper);
  if (word.startsWith("--")) {
    const eq = word.indexOf("=");
    if (eq >= 0) {
      const name = word.slice(0, eq);
      return long.includes(name) ? [1, [name, word.slice(eq + 1)]] : [1, null];
    }
    if (long.includes(word)) return [2, i + 1 < words.length ? [word, words[i + 1]] : null];
    return [1, null];
  }
  const cluster = word.slice(1);
  let at = 0;
  for (const c of cluster) {
    if (short.includes(c)) {
      const rest = cluster.slice(at + c.length);
      const option = `-${c}`;
      return rest === "" ? [2, i + 1 < words.length ? [option, words[i + 1]] : null] : [1, [option, rest]];
    }
    at += c.length;
  }
  return [1, null];
}

/** Git subcommands that change a repository's files or history, or a remote's. */
const GIT_CHANGES = ["commit", "push", "apply", "am", "cherry-pick", "merge", "rebase", "revert", "mv", "rm"];

/** Whether a shell command changes code. `depth` limits how deep `bash -c '...'` is followed. */
function command_changes_code(command: string, depth: number): boolean {
  const tokens = tokenize(command);
  let words: string[] = [];
  let heredocs: string[] = [];
  let k = 0;
  for (;;) {
    const t = k < tokens.length ? tokens[k++] : undefined;
    if (t?.t === "Word") words.push(t.w);
    else if (t?.t === "HereDoc") heredocs.push(t.body);
    else if (t?.t === "Output") {
      const target = k < tokens.length ? tokens[k++] : undefined;
      if (target?.t === "Word" && !scratch(target.w)) return true;
    } else if (t?.t === "Input") {
      if (tokens[k]?.t === "Word") k++;
    } else {
      // Control, or the end.
      if (simple_command_changes_code(words, heredocs, depth)) return true;
      words = [];
      heredocs = [];
      if (k >= tokens.length) return false;
    }
  }
}

/**
 * Whether a shell command runs `program` (by name, wherever it's installed) in any of its simple commands, including
 * command substitutions (`$(…)` and backticks, quoted or not), after reserved words (`if`, `!`, `do`, …) and wrappers
 * such as `env`, and in scripts given to a shell.
 */
export function runs_program(command: string, program: string): boolean {
  return runs(command, program, 0);
}

/** Reserved words that can come before a simple command's program. */
const RESERVED = ["if", "then", "else", "elif", "while", "until", "do", "!", "{"];

function runs(command: string, program: string, depth: number): boolean {
  const found = substitutions(command);
  // A substitution that never ends is a syntax error to bash, but one it may read differently (where its end is hard
  // to tell): it doesn't pass.
  if (found.unclosed || (depth < 3 && found.bodies.some((body) => runs(body, program, depth + 1)))) return true;
  const tokens = tokenize(command);
  let words: string[] = [];
  let heredocs: string[] = [];
  let k = 0;
  for (;;) {
    const t = k < tokens.length ? tokens[k++] : undefined;
    if (t?.t === "Word") words.push(t.w);
    else if (t?.t === "HereDoc") heredocs.push(t.body);
    else if (t?.t === "Output" || t?.t === "Input") {
      if (tokens[k]?.t === "Word") k++;
    } else {
      const split: string[] = [];
      const i = command_index(words, split);
      if (depth < 3 && split.some((script) => runs(script, program, depth + 1))) return true;
      const name = i < words.length ? basename(words[i]) : null;
      const args = words.slice(i + 1);
      let found = false;
      if (name !== null && name === program) found = true;
      else if ((name === "bash" || name === "sh" || name === "zsh") && depth < 3) {
        found = shell_scripts(args, heredocs).some((script) => runs(script, program, depth + 1));
      } else if (name === "eval" && depth < 3) {
        // `eval` runs its arguments, joined, as a script.
        found = runs(args.join(" "), program, depth + 1);
      }
      if (found) return true;
      words = [];
      heredocs = [];
      if (k >= tokens.length) return false;
    }
  }
}

/** What `substitutions` finds: the commands in them, and whether one never ends. */
export interface Found {
  bodies: string[];
  unclosed: boolean;
}

/**
 * The commands in a shell command's substitutions, `$(…)` and `` `…` ``, where bash expands them: outside single quotes
 * (double quotes don't stop them) and comments, and in here-documents whose delimiter isn't quoted. A substitution's
 * own text is read the same way, so its end is the `)` bash would end it at, not one in quotes, a comment or a
 * here-document.
 */
export function substitutions(command: string): Found {
  const chars = Array.from(command);
  const out: Found = { bodies: [], unclosed: false };
  scan_substitutions(chars, { i: 0 }, "Script", out);
  return out;
}

/**
 * What `scan_substitutions` reads: `Script` is shell code, to its end; `Substitution` the inside of a `$(`, up to the
 * `)` that closes it; `HereDoc` an expanded here-document's body, where quotes and `#` are only text.
 */
type Scan = "Script" | "Substitution" | "HereDoc";

/**
 * Read `chars` from `pos.i`, adding the substitutions found to `out`, and leave `pos.i` after what was read (after the
 * closing `)` for a `Substitution`).
 */
function scan_substitutions(chars: string[], pos: { i: number }, scan: Scan, out: Found): void {
  let double = false;
  // Parentheses opened inside a substitution (subshells, `$((…))`), which its `)` isn't.
  let depth = 0;
  // Whether the next character starts a word (where `#` starts a comment).
  let word_start = true;
  // Here-documents started on the current line: their delimiter, whether their body is expanded (the delimiter isn't
  // quoted), and whether their lines' leading tabs are stripped.
  let heredocs: Array<[string, boolean, boolean]> = [];
  // The word being read, unquoted (quotes make it no keyword), and whether it's where a command starts, to follow
  // `case … in … esac`: for each case open, whether its `in` has come; and whether a pattern is being read, whose `)`
  // doesn't close anything.
  let word = "";
  let at_command = true;
  const cases: boolean[] = [];
  let pattern = false;
  // Whether the word being read is a pattern's first (where `esac` is the keyword, not after `|`), and whether the
  // last word was `time` (whose options a command can follow too).
  let pattern_first = false;
  let after_time = false;
  // As Rust's: the position moves on even past the end.
  const next = (): string | undefined => {
    const c = chars[pos.i];
    pos.i++;
    return c;
  };
  const at = (k: number): string | undefined => chars[k];
  for (let c = next(); c !== undefined; c = next()) {
    let starts_word = false;
    if (!double && (is_ws(c) || ";&|()<>".includes(c))) {
      const w = word;
      word = "";
      if (w === "case" && at_command && !pattern) cases.push(false);
      else if (w === "in" && cases.length && cases.at(-1) === false) {
        cases.pop();
        cases.push(true);
        pattern = true;
        pattern_first = true;
      } else if (w === "esac" && cases.length && (pattern ? pattern_first : at_command)) {
        // As an argument, or a pattern's after `|`, it's just a word.
        cases.pop();
        pattern = false;
      }
      if (w !== "") {
        // A command can follow a reserved word or prefix only where that word started one: as an argument
        // (`echo do`), it's just a word.
        const prefix = RESERVED.includes(w) || ["then", "do", "else", "elif", "!", "time", "coproc"].includes(w);
        const time_option = after_time && w.startsWith("-");
        after_time = at_command && (w === "time" || time_option);
        at_command = at_command && (prefix || time_option);
        pattern_first = false;
      }
      // In a pattern, `|` separates its alternatives.
      if (c === "\n" || ";&()".includes(c) || (c === "|" && !pattern)) at_command = true;
    }
    if (c === "\\") {
      word += c;
      pos.i++;
    } else if (c === "$" && at(pos.i) === "$") {
      // `$$` is a variable, not the start of `$(` or `$'`.
      word += "$$";
      pos.i++;
    } else if (c === "$" && at(pos.i) === "(") {
      word += c;
      pos.i++;
      const start = pos.i;
      scan_substitutions(chars, pos, "Substitution", out);
      const end = Math.min(Math.max(pos.i - 1, start), chars.length);
      const body = chars.slice(start, end).join("");
      // `case` syntax is the easiest to misread where a substitution ends, so with what may be one in it (`case` and
      // `esac`), the rest of the command is read as part of it too.
      const words = body.split(/[^A-Za-z0-9_]/);
      if (words.includes("case") && words.includes("esac")) out.bodies.push(chars.slice(Math.min(start, chars.length)).join(""));
      out.bodies.push(body);
    } else if (c === "`") {
      word += c;
      let body = "";
      let closed = false;
      for (let d = next(); d !== undefined; d = next()) {
        if (d === "`") {
          closed = true;
          break;
        }
        if (d === "\\") body += next() ?? "";
        else body += d;
      }
      out.unclosed ||= !closed;
      out.bodies.push(body);
    } else if (scan === "HereDoc") {
      // Quotes, comments and the rest are only text in a here-document.
    } else if (c === "$" && !double && at(pos.i) === "'") {
      // `$'…'` may have escaped quotes (`\'`) in it.
      word += "$'";
      pos.i++;
      ansi_c_at(chars, pos);
    } else if (c === "'" && !double) {
      word += c;
      for (let d = next(); d !== undefined && d !== "'"; d = next()) {}
    } else if (c === '"') {
      word += c;
      double = !double;
    } else if (c === "#" && !double && word_start) {
      while (at(pos.i) !== undefined && at(pos.i) !== "\n") pos.i++;
    } else if (c === "(" && !double && scan === "Substitution") {
      // A pattern may start with `(` too.
      if (!pattern) depth++;
      starts_word = true;
    } else if (c === ")" && !double && scan === "Substitution") {
      if (pattern) pattern = false;
      else if (depth === 0) return;
      else depth--;
      starts_word = true;
    } else if (c === "<" && !double && at(pos.i) === "<") {
      pos.i++;
      // `<<<` is a here-string, a word like any other.
      if (at(pos.i) === "<") pos.i++;
      else {
        const strip_tabs = at(pos.i) === "-";
        if (strip_tabs) pos.i++;
        while (at(pos.i) === " " || at(pos.i) === "\t") pos.i++;
        // The delimiter is a word, quotes removed: quoted, it may have spaces in it.
        let delimiter = "";
        let quoted = false;
        for (let n = at(pos.i); n !== undefined && !is_ws(n) && !";&|()<>".includes(n); n = at(pos.i)) {
          pos.i++;
          if (n === "$" && at(pos.i) === "'") {
            quoted = true;
            pos.i++;
            delimiter += ansi_c_at(chars, pos);
          } else if (n === "$" && at(pos.i) === '"') {
            // `$"…"` is quoted like `"…"`.
          } else if (n === "'") {
            quoted = true;
            for (let d = next(); d !== undefined && d !== "'"; d = next()) delimiter += d;
          } else if (n === '"') {
            quoted = true;
            for (let d = next(); d !== undefined && d !== '"'; d = next()) {
              if (d === "\\") delimiter += next() ?? "";
              else delimiter += d;
            }
          } else if (n === "\\") {
            quoted = true;
            delimiter += next() ?? "";
          } else delimiter += n;
        }
        heredocs.push([delimiter, !quoted, strip_tabs]);
      }
    } else if (c === "\n" && !double) {
      // The bodies of the line's here-documents follow it, each up to its delimiter.
      const started = heredocs;
      heredocs = [];
      for (const [delimiter, expanded, strip_tabs] of started) {
        const body: string[] = [];
        while (pos.i < chars.length) {
          let end = chars.indexOf("\n", pos.i);
          if (end < 0) end = chars.length;
          const line = chars.slice(pos.i, end).join("");
          pos.i = end + 1;
          if ((strip_tabs ? line.replace(/^\t+/, "") : line) === delimiter) break;
          body.push(...Array.from(line), "\n");
        }
        if (expanded) scan_substitutions(body, { i: 0 }, "HereDoc", out);
      }
      starts_word = true;
    } else if (!double && (is_ws(c) || ";&|".includes(c))) {
      // `;;`, `;&` and `;;&` end a case's command list: a pattern comes next.
      if (c === ";" && (at(pos.i) === ";" || at(pos.i) === "&") && cases.at(-1) === true) {
        pattern = true;
        pattern_first = true;
      }
      starts_word = true;
    } else if (!double) {
      word += c;
    }
    word_start = starts_word;
  }
  // The input ended before the substitution's `)`.
  if (scan === "Substitution") out.unclosed = true;
}

/** `ansi_c_quoted` on `chars` from `pos.i`, leaving `pos.i` after the closing quote. */
function ansi_c_at(chars: string[], pos: { i: number }): string {
  const p = { i: Math.min(pos.i, chars.length) };
  const text = ansi_c_quoted(chars, p);
  pos.i = p.i;
  return text;
}

/**
 * Where the program is in a simple command's words as bash runs them: after reserved words, pipeline prefixes
 * (`time [-p]`, `!`, `coproc`), variable assignments and wrappers, in any order (`time ! gh`, `env X=1 gh`). See
 * `program_index` for `split`.
 */
function command_index(words: string[], split: string[]): number {
  let i = 0;
  for (;;) {
    const before = i;
    while (i < words.length) {
      const w = words[i];
      if (RESERVED.includes(w) || w === "coproc") i++;
      else if (w === "time") {
        i++;
        while (i < words.length && (words[i] === "-p" || words[i] === "--")) i++;
      } else break;
    }
    i += program_index(words.slice(i), split);
    if (i === before) return i;
  }
}

/**
 * Where the program is in a simple command's words: after variable assignments and wrappers such as `timeout 900`. The
 * commands `env -S` is given to split are added to `split`.
 */
function program_index(words: string[], split: string[]): number {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    const eq = w.indexOf("=");
    const assignment = eq > 0 && /^[A-Za-z0-9_]+$/.test(w.slice(0, eq));
    if (assignment) i++;
    else if (WRAPPERS.includes(basename(w))) {
      const wrapper = basename(w);
      i++;
      // Its options (and their values), and the durations, priorities and assignments some take.
      while (i < words.length) {
        const w = words[i];
        if (w === "--") {
          i++;
          break;
        } else if (w.startsWith("-") && w.length > 1) {
          const [taken, value] = wrapper_option(wrapper, words, i);
          if (wrapper === "env" && value) {
            const [option, command] = value;
            if (option === "-S" || option === "--split-string") split.push(`env ${command}`);
          }
          // An option missing its value (`env -u`) takes up what's left.
          i = Math.min(i + taken, words.length);
        } else if (is_ascii_digit(w[0]) || w.includes("=")) i++;
        else break;
      }
    } else break;
  }
  return i;
}

/**
 * Whether one simple command (its words, without redirects, and the here-documents it's given) changes code. A
 * here-document is only read as a script when it's given to a shell.
 */
function simple_command_changes_code(words: string[], heredocs: string[], depth: number): boolean {
  const i = program_index(words, []);
  if (i >= words.length) return false;
  const name = basename(words[i]);
  const args = words.slice(i + 1);
  const operands = () => args.filter((a) => !a.startsWith("-"));
  switch (name) {
    case "git":
      return GIT_CHANGES.includes(git_subcommand(args));
    case "gh":
      return args[0] === "pr" && args[1] === "create";
    case "sed":
    case "perl":
      return args.some((a) => a.startsWith("--in-place") || (a.startsWith("-") && !a.startsWith("--") && in_place_flag(a)));
    case "patch":
      return true;
    case "tee":
    case "touch":
    case "rm":
    case "rmdir":
    case "mkdir":
    case "truncate":
      return operands().some((a) => !scratch(a));
    case "cp":
    case "mv":
    case "install":
    case "ln":
    case "rsync": {
      const last = operands().at(-1);
      return last !== undefined && !scratch(last);
    }
    case "bash":
    case "sh":
    case "zsh":
      return depth < 3 && shell_scripts(args, heredocs).some((script) => command_changes_code(script, depth + 1));
    default:
      return false;
  }
}

/** The scripts a shell runs, given its arguments and here-documents: its `-c` script, or else what it reads from a here-document. */
function shell_scripts(args: string[], heredocs: string[]): string[] {
  const p = args.findIndex((a) => a.startsWith("-") && !a.startsWith("--") && a.includes("c"));
  if (p >= 0) return p + 1 < args.length ? [args[p + 1]] : [];
  return [...heredocs];
}

/** Whether a short-option cluster for sed or perl edits in place: `-i`, `-i.bak`, `-pi`, `-Ei`. */
function in_place_flag(arg: string): boolean {
  const m = /^[A-Za-z]*/.exec(arg.slice(1))![0];
  return m.includes("i");
}

function basename(word: string): string {
  const k = word.lastIndexOf("/");
  return k < 0 ? word : word.slice(k + 1);
}

/** Whether a path is a scratch place whose writes aren't code changes. */
function scratch(path: string): boolean {
  return ["/dev/", "/tmp/", "/var/tmp/", "$TMPDIR", "${TMPDIR"].some((p) => path.startsWith(p)) || path === "/tmp";
}

/** The subcommand in a git command's arguments, after its options (such as `-C <dir>`). */
function git_subcommand(args: string[]): string {
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === "-C" || a === "-c" || a === "--git-dir" || a === "--work-tree" || a === "--namespace") i += 2;
    else if (a.startsWith("-")) i++;
    else return a;
  }
  return "";
}
