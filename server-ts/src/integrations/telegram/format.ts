// Port of server/src/integrations/telegram/format.rs: the assistant's Markdown as Telegram's HTML (its
// `parse_mode: "HTML"`, which is easier to get right than MarkdownV2's escaping), in messages short enough to send.
//
// Telegram takes a few tags (b, i, s, code, pre, a, blockquote) and refuses a message whose tags don't balance, so every
// tag here is opened and closed in one place, and anything that doesn't close on its line (a lone `*`) stays as it was
// typed. A message it still refuses is sent as plain text (see telegram.ts).
//
// Lengths are in characters (code points), as Rust's `chars()` counts them, not UTF-16 units.

/** The longest message Telegram takes, in characters (after its markup is taken out). */
export const MAX_CHARS = 4096;

/**
 * How long a piece of a long reply is, at most, in characters of Markdown: the HTML's text is no longer than that, so it
 * fits with room to spare.
 */
export const PIECE_CHARS = 3800;

/** Text as it goes between Telegram's HTML tags. */
export function escape(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** How many characters `s` has. */
function count(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** `text` cut to `max` characters, with an ellipsis if it was longer. */
export function cut(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, Math.max(max - 1, 0)).join("")}…`;
}

/**
 * Splits Markdown into pieces of at most `max` characters, at blank lines where it can, else at line ends, else
 * anywhere. A code block that's split is closed at the end of one piece and opened again at the start of the next, so
 * each piece reads on its own.
 */
export function split(md: string, max: number): string[] {
  md = md.trimEnd();
  if (count(md) <= max) return md.trim() === "" ? [] : [md];
  const pieces: string[] = [];
  let cur = "";
  let cur_len = 0;
  // The fence of the code block the current line is in, if any (its opening line).
  let fence: string | null = null;
  // Lines are long at most `max - 8` (room for the fences a piece may gain): longer ones are cut.
  const room = Math.max(max - 8, 1);
  const lines: string[] = [];
  for (const l of md.split("\n")) {
    const chars = Array.from(l);
    if (chars.length <= room) lines.push(l);
    else for (let i = 0; i < chars.length; i += room) lines.push(chars.slice(i, i + room).join(""));
  }
  for (const line of lines) {
    const len = count(line) + 1;
    const reopen = fence === null ? 0 : count(fence) + 1;
    if (cur_len + len + 4 > max && cur !== "") {
      // Back to the last blank line outside a code block, if there's one in the second half.
      let cut_at: number | null = null;
      if (fence === null) {
        const i = cur.lastIndexOf("\n\n");
        if (i >= 0 && i > Math.floor(cur.length / 2)) cut_at = i;
      }
      if (cut_at !== null) {
        const rest = cur.slice(cut_at + 2);
        pieces.push(cur.slice(0, cut_at));
        cur = rest;
        cur_len = count(rest);
        if (cur_len + len + 4 > max) {
          pieces.push(cur);
          cur = "";
          cur_len = 0;
        }
      } else {
        if (fence !== null) cur += "\n```";
        pieces.push(cur);
        cur = "";
        cur_len = 0;
        if (fence !== null) {
          cur += fence;
          cur_len = reopen;
        }
      }
    }
    if (cur !== "") cur += "\n";
    cur += line;
    cur_len += len;
    if (line.trimStart().startsWith("```")) fence = fence !== null ? null : line.trim();
  }
  if (cur.trim() !== "") pieces.push(cur);
  return pieces.map((p) => p.replace(/^\n+|\n+$/g, "")).filter((p) => p.trim() !== "");
}

/** Rust's `str::lines`: split at line ends (a `\r` before one goes too), with no empty line after a last line end. */
function lines_of(s: string): string[] {
  const out = s.split("\n");
  if (out[out.length - 1] === "") out.pop();
  return out.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/**
 * Markdown as Telegram's HTML: headings in bold, lists with bullets, quotes, code blocks, tables as preformatted text, and
 * inline bold, italics, strikethrough, code and links.
 */
export function to_html(md: string): string {
  const out: string[] = [];
  const lines = lines_of(md);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```")) {
      let lang = "";
      for (const c of trimmed.slice(3).trim()) {
        if (!/^[A-Za-z0-9_+-]$/.test(c)) break;
        lang += c;
      }
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        body.push(lines[i]);
        i++;
      }
      i++;
      const code = escape(body.join("\n"));
      out.push(lang === "" ? `<pre>${code}</pre>` : `<pre><code class="language-${lang}">${code}</code></pre>`);
      continue;
    }
    if (trimmed.startsWith("|")) {
      const table: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith("|")) {
        // The line under the header (|---|---|) says nothing in plain text.
        const row = lines[i].trim();
        if (!/^[|\-: ]*$/.test(row)) table.push(row);
        i++;
      }
      out.push(`<pre>${escape(table.join("\n"))}</pre>`);
      continue;
    }
    if (trimmed.startsWith(">")) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith(">")) {
        const l = lines[i].trimStart().replace(/^>+/, "");
        quote.push(inline(l.startsWith(" ") ? l.slice(1) : l));
        i++;
      }
      out.push(`<blockquote>${quote.join("\n")}</blockquote>`);
      continue;
    }
    out.push(block_line(line));
    i++;
  }
  return out.join("\n");
}

/** One line outside code blocks, tables and quotes. */
function block_line(line: string): string {
  const trimmed = line.trimStart();
  const indent = line.slice(0, line.length - trimmed.length);
  let hashes = 0;
  while (trimmed[hashes] === "#") hashes++;
  if (hashes >= 1 && hashes <= 6 && trimmed.slice(hashes).startsWith(" ")) return `<b>${inline(trimmed.slice(hashes).trim())}</b>`;
  if (trimmed.length >= 3 && (/^-+$/.test(trimmed) || /^\*+$/.test(trimmed) || /^_+$/.test(trimmed))) return "──────────";
  for (const bullet of ["- ", "* ", "+ "]) {
    if (!trimmed.startsWith(bullet)) continue;
    const rest = trimmed.slice(bullet.length);
    let item: string;
    if (rest.startsWith("[ ] ")) item = `☐ ${inline(rest.slice(4))}`;
    else if (rest.startsWith("[x] ")) item = `☑ ${inline(rest.slice(4))}`;
    else item = `• ${inline(rest)}`;
    return `${escape(indent)}${item}`;
  }
  return `${escape(indent)}${inline(trimmed)}`;
}

/** Rust's `char::is_whitespace` and `char::is_alphanumeric`. */
const is_ws = (c: string | undefined) => c !== undefined && /^\s$/u.test(c);
const is_alnum = (c: string | undefined) => c !== undefined && /^[\p{Alphabetic}\p{N}]$/u.test(c);

const PAIRS: Array<[string, string]> = [
  ["**", "b"],
  ["__", "b"],
  ["~~", "s"],
  ["*", "i"],
  ["_", "i"],
];

/**
 * Inline Markdown in one line: `code`, **bold**, __bold__, *italics*, _italics_, ~~struck~~ and [links](https://…). A
 * delimiter with no partner on the line is kept as text.
 */
export function inline(s: string): string {
  const chars = Array.from(s);
  let out = "";
  let i = 0;
  const at = (i: number, pat: string) => Array.from(pat).every((c, k) => chars[i + k] === c);
  const find = (from: number, pat: string): number | null => {
    for (let j = from; j < chars.length; j++) if (at(j, pat)) return j;
    return null;
  };
  const text = (a: number, b: number) => chars.slice(a, b).join("");
  while (i < chars.length) {
    const c = chars[i];
    if (c === "\\" && i + 1 < chars.length && "\\`*_~[]()#>-+!|".includes(chars[i + 1])) {
      out += escape(chars[i + 1]);
      i += 2;
      continue;
    }
    if (c === "`") {
      // As many backticks close it as opened it.
      let n = 0;
      while (chars[i + n] === "`") n++;
      const fence = "`".repeat(n);
      const j = find(i + n, fence);
      if (j !== null && j > i + n) {
        out += `<code>${escape(text(i + n, j).trim())}</code>`;
        i = j + n;
        continue;
      }
      out += fence;
      i += n;
      continue;
    }
    if (c === "[") {
      const close = find(i + 1, "](");
      const end = close === null ? null : find(close + 2, ")");
      if (close !== null && end !== null) {
        const url = text(close + 2, end).trim();
        if ((url.startsWith("https://") || url.startsWith("http://")) && !/\s/u.test(url)) {
          out += `<a href="${escape(url).replaceAll('"', "&quot;")}">${inline(text(i + 1, close))}</a>`;
          i = end + 1;
          continue;
        }
      }
    }
    let matched = false;
    for (const [delim, tag] of PAIRS) {
      if (!at(i, delim)) continue;
      const n = delim.length;
      // Not where it's part of a word (snake_case) or followed by a space (a list's "* ").
      const after = chars[i + n];
      if (after === undefined || is_ws(after) || (delim.startsWith("_") && i > 0 && is_alnum(chars[i - 1]))) continue;
      const j = find(i + n, delim);
      if (j === null) continue;
      if (j === i + n || is_ws(chars[j - 1]) || (delim.startsWith("_") && is_alnum(chars[j + n]))) continue;
      out += `<${tag}>${inline(text(i + n, j))}</${tag}>`;
      i = j + n;
      matched = true;
      break;
    }
    if (matched) continue;
    out += escape(c);
    i++;
  }
  return out;
}
