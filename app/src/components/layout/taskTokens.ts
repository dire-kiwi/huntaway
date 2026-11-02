// Tokens typed in a new task's description that set its options (IA-220): `/plan` its type, `@IA` where it goes,
// `!sonnet` its model, `^high` its effort, `#IA-212` a task it depends on and `from:IA-12` what its worktree starts from
// (HA-55: another task, a branch, a pull request or a commit).
//
// A token is its prefix at the start of a word, with the value right after it, so `# Heading` isn't one. Only values
// the dialog knows count (`@someone` and `#123` stay text), and nothing in a code span or fenced code block is a token.

import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";

export const TOKEN_PREFIXES = ["/", "@", "!", "^", "#", "from:"] as const;
export type TokenPrefix = (typeof TOKEN_PREFIXES)[number];

export interface Token {
  prefix: TokenPrefix;
  /** What follows the prefix, as typed. */
  word: string;
  /** Where it is in the text, the prefix included. */
  start: number;
  end: number;
  /** The value it's known as (as the vocabulary has it), when it's one. */
  value?: string;
}

/** The values each prefix knows, matched without regard to case. */
export type Vocab = Partial<Record<TokenPrefix, readonly string[]>>;

// A value ends in a letter or digit, so a full stop or a dash after it isn't part of it; and isn't followed by a path,
// another prefix or a bracket (`/home/me`, `@IA/x` and `!claude-opus-5-5[1m]` aren't tokens).
const TOKEN = /(?<=^|\s)([/@!^#])([\w.-]*\w)(?![\w/@#^[-])/g;
// `from:` takes a branch (`feature/x`), a pull request (`#12`, or its URL) too, up to a space or what ends a sentence.
const FROM = /(?<=^|\s)(from:)([^\s`'"<>()]*[^\s`'"<>().,;:!?])/g;

let parsed: { text: string; ranges: [number, number][] } | null = null;

/**
 * The code in markdown (code spans, and fenced or indented code blocks, in lists and quotes too), as [start, end)
 * ranges in order. Parsed as the board's markdown is, and kept for the text last asked about, as it's asked for
 * again on each keystroke.
 */
export function codeRanges(text: string): [number, number][] {
  if (parsed?.text === text) return parsed.ranges;
  const ranges: [number, number][] = [];
  const visit = (node: Nodes) => {
    if ((node.type === "code" || node.type === "inlineCode") && node.position) ranges.push([node.position.start.offset!, node.position.end.offset!]);
    else if ("children" in node) node.children.forEach(visit);
  };
  visit(fromMarkdown(text));
  parsed = { text, ranges };
  return ranges;
}

const inRanges = (at: number, ranges: [number, number][]) => ranges.some(([s, e]) => at >= s && at < e);

/** Everything in the text that could be a token, outside code, before it's looked up. */
export function findTokens(text: string): Token[] {
  const code = codeRanges(text);
  return [...text.matchAll(TOKEN), ...text.matchAll(FROM)]
    .filter((m) => !inRanges(m.index!, code))
    .sort((a, b) => a.index! - b.index!)
    .map((m) => ({ prefix: m[1] as TokenPrefix, word: m[2], start: m.index!, end: m.index! + m[0].length }));
}

/** A project `@` can name, by its key, and its host's and profile's names to tell it from another with the same key. */
export interface Place {
  key: string;
  host: string;
  profile: string;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "x";

/**
 * The word `@` takes for each place, in order: its key; or, when another place has the same key (on another host or
 * profile) or it's one of `reserved` (`none`, `group`), its key, a dot and its host's name, or its profile's if that's
 * what tells them apart (`IA.laptop`). Keys are letters and digits, so a word with a dot is never a key.
 */
export function placeWords(places: Place[], reserved: readonly string[]): string[] {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const words = places.map((p) => {
    const others = places.filter((o) => o !== p && same(o.key, p.key));
    if (!others.length && !reserved.some((r) => same(r, p.key))) return p.key;
    const host = slug(p.host);
    const profile = slug(p.profile);
    if (others.every((o) => slug(o.host) !== host)) return `${p.key}.${host}`;
    if (others.every((o) => slug(o.profile) !== profile)) return `${p.key}.${profile}`;
    return `${p.key}.${host}.${profile}`;
  });
  // Still the same (two projects keyed alike in one profile's past and present): numbered.
  return words.map((w, i) => (words.some((x, j) => j !== i && same(x, w)) ? `${w}.${i + 1}` : w));
}

/** The value `word` is in `values`, by any case. */
export const lookup = (values: readonly string[] | undefined, word: string) => values?.find((v) => v.toLowerCase() === word.toLowerCase());

/** The tokens with their values from `vocab`; those it doesn't know are left without one. */
export const resolveTokens = (tokens: Token[], vocab: Vocab): Token[] =>
  tokens.map(({ value: _, ...t }) => {
    const value = lookup(vocab[t.prefix], t.word);
    return value === undefined ? t : { ...t, value };
  });

/** The value the last known token with `prefix` sets (a later one wins). */
export const lastValue = (tokens: Token[], prefix: TokenPrefix) => tokens.findLast((t) => t.prefix === prefix && t.value !== undefined)?.value;

/** Every value tokens with `prefix` set, once each, in order (for `#`, which can be given more than once). */
export const allValues = (tokens: Token[], prefix: TokenPrefix) => [
  ...new Set(tokens.flatMap((t) => (t.prefix === prefix && t.value !== undefined ? [t.value] : []))),
];

/**
 * The text without `tokens`, tidied: a token takes a space next to it along, a line left with nothing but tokens goes
 * (with a blank line next to it, if that leaves two), and blank lines and spaces at the start and end go. Text
 * without tokens to remove comes back as it is.
 */
export function removeTokens(text: string, tokens: Token[]): string {
  if (!tokens.length) return text;
  const lines: { text: string; emptied: boolean }[] = [];
  let at = 0;
  for (const line of text.split("\n")) {
    const end = at + line.length;
    const mine = tokens.filter((t) => t.start >= at && t.end <= end).sort((a, b) => b.start - a.start);
    let out = line;
    for (const t of mine) {
      let s = t.start - at;
      let e = t.end - at;
      if (e < out.length && /[ \t]/.test(out[e])) e++;
      else while (s > 0 && /[ \t]/.test(out[s - 1])) s--;
      out = out.slice(0, s) + out.slice(e);
    }
    lines.push({ text: out, emptied: mine.length > 0 && !out.trim() });
    at = end + 1;
  }
  const blank = (l?: { text: string }) => !!l && !l.text.trim();
  const kept: { text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].emptied) {
      kept.push(lines[i]);
      continue;
    }
    // Between two blank lines (or at the start, before one), the blank line after it goes too.
    if ((blank(kept.at(-1)) || !kept.length) && blank(lines[i + 1]) && !lines[i + 1].emptied) i++;
  }
  return kept
    .map((l) => l.text)
    .join("\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .trimEnd();
}

/** The text without its known tokens, as its agent is given it. */
export const stripTokens = (text: string, tokens: Token[]) =>
  removeTokens(
    text,
    tokens.filter((t) => t.value !== undefined),
  );

/** A token being typed at the caret: its prefix, what's typed of its value so far, and the word it's in. */
export interface Completion {
  prefix: TokenPrefix;
  query: string;
  start: number;
  end: number;
}

/** The token the caret is in, to suggest values for, unless it's in code. */
export function completionAt(text: string, caret: number): Completion | null {
  const before = text.slice(0, caret);
  const m = /(?<=^|\s)(from:)(\S*)$/.exec(before) ?? /(?<=^|\s)([/@!^#])([\w.-]*)$/.exec(before);
  if (!m || inRanges(m.index, codeRanges(text))) return null;
  const rest = (m[1] === "from:" ? /^\S*/ : /^[\w.-]*/).exec(text.slice(caret))![0];
  return { prefix: m[1] as TokenPrefix, query: m[2], start: m.index, end: caret + rest.length };
}

/** Puts `prefix` and `value` in place of the word being completed, with a space after, and where the caret goes. */
export function insertCompletion(text: string, at: { start: number; end: number }, prefix: TokenPrefix, value: string): { text: string; caret: number } {
  const token = prefix + value;
  const after = text.slice(at.end);
  return { text: text.slice(0, at.start) + token + (after.startsWith(" ") ? "" : " ") + after, caret: at.start + token.length + 1 };
}
