// Syntax highlighting for the Changes tab's diffs (HA-10). Shiki (VS Code's TextMate grammars, with its JavaScript
// regex engine) runs in a worker (highlight.worker.ts), so a big diff doesn't hold the page up, and each language's
// grammar is fetched the first time a file in it is shown. Each hunk's old and new sides are highlighted as code
// of their own (a hunk is all of the file there is), and the lines show plain until their colours come.
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { FileDiff } from "./changes";

/** A highlighted line, in runs: how many characters, and their style (an index into the styles; 0 is the default). */
export type Run = [length: number, style: number];
/** A file's highlighted lines, by hunk and line (as its `hunks[h].lines[l]`); a line with none shows plain. */
export type FileRuns = (Run[] | undefined)[][];

/** Files with more lines than this in their diff aren't highlighted. */
export const MAX_LINES = 5000;

/** The languages the worker has grammars for (see its GRAMMARS), by file extension. */
const BY_EXT: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  json: "json", jsonc: "jsonc", json5: "jsonc", rs: "rust", py: "python", pyi: "python", go: "go", java: "java", kt: "kotlin", kts: "kotlin",
  swift: "swift", c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp", cs: "csharp", rb: "ruby", php: "php",
  html: "html", htm: "html", css: "css", scss: "scss", less: "less", md: "markdown", markdown: "markdown", yaml: "yaml", yml: "yaml",
  toml: "toml", sql: "sql", sh: "shellscript", bash: "shellscript", zsh: "shellscript", fish: "fish", ps1: "powershell", mk: "make",
  xml: "xml", svg: "xml", plist: "xml", vue: "vue", svelte: "svelte", astro: "astro", lua: "lua", ini: "ini", cfg: "ini", graphql: "graphql",
  gql: "graphql", proto: "proto", ex: "elixir", exs: "elixir", hs: "haskell", scala: "scala", dart: "dart", zig: "zig", nix: "nix",
  tf: "terraform", hcl: "hcl", diff: "diff", patch: "diff", r: "r", jl: "julia", clj: "clojure", pl: "perl", pm: "perl", elm: "elm",
  sol: "solidity", cmake: "cmake", groovy: "groovy", gradle: "groovy", prisma: "prisma", nginx: "nginx", env: "dotenv",
};
/** And by file name, for files with no extension that tells. */
const BY_NAME: Record<string, string> = {
  dockerfile: "docker", containerfile: "docker", makefile: "make", gnumakefile: "make", justfile: "just", "cmakelists.txt": "cmake",
  "cargo.lock": "toml", "poetry.lock": "toml", "uv.lock": "toml", ".bashrc": "shellscript", ".zshrc": "shellscript", ".profile": "shellscript",
  ".bash_profile": "shellscript", ".env": "dotenv", pkgbuild: "shellscript", "nginx.conf": "nginx",
};

/** The language a file is highlighted as, or null for none. */
export function langFor(path: string): string | null {
  const name = path.split("/").pop()!.toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  if (/^dockerfile\.|\.dockerfile$/.test(name)) return "docker";
  if (/^\.env\./.test(name)) return "dotenv";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? (BY_EXT[name.slice(dot + 1)] ?? null) : null;
}

/** What's highlighted for a file: each hunk's old side and new side, and where each line is in them. */
export interface Sides {
  texts: string[];
  /** For each hunk's lines, which text (old sides are even, new ones odd) and which line of it. */
  at: [text: number, line: number][][];
}

const sidesCache = new WeakMap<FileDiff, Sides>();
export function sidesOf(file: FileDiff): Sides {
  let s = sidesCache.get(file);
  if (s) return s;
  const texts: string[] = [];
  const at: [number, number][][] = [];
  file.hunks.forEach((h, hi) => {
    const old: string[] = [];
    const neu: string[] = [];
    at.push(
      h.lines.map((l): [number, number] => {
        if (l.kind === "-") return [2 * hi, old.push(l.text) - 1];
        // Context is on both sides: the new one's colours are used.
        if (l.kind === " ") old.push(l.text);
        return [2 * hi + 1, neu.push(l.text) - 1];
      }),
    );
    texts.push(old.join("\n"), neu.join("\n"));
  });
  sidesCache.set(file, (s = { texts, at }));
  return s;
}

/** Whether a file is highlighted at all: a language it's in, and not too big. */
export function highlightable(file: FileDiff): string | null {
  if (file.binary || file.combined || !file.hunks.length) return null;
  const lang = langFor(file.path);
  if (!lang) return null;
  return file.hunks.reduce((n, h) => n + h.lines.length, 0) > MAX_LINES ? null : lang;
}

// The worker, started the first time something's highlighted, and its answers.
let worker: Worker | null = null;
let failed = false;
let seq = 0;
const waiting = new Map<number, (lines: Run[][][] | null) => void>();
/** Styles by index, as the worker last sent them ("#rrggbb|fontStyle"), and as CSS. */
let styles: string[] = [];
const css: CSSProperties[] = [];

function call(lang: string, texts: string[]): Promise<Run[][][] | null> {
  if (failed) return Promise.resolve(null);
  if (!worker) {
    try {
      worker = new Worker(new URL("./highlight.worker.ts", import.meta.url), { type: "module" });
    } catch {
      failed = true;
      return Promise.resolve(null);
    }
    worker.onmessage = (e: MessageEvent<{ id: number; lines?: Run[][][]; styles?: string[] }>) => {
      const { id, lines, styles: s } = e.data;
      if (s) styles = s;
      waiting.get(id)?.(lines ?? null);
      waiting.delete(id);
    };
    worker.onerror = () => {
      // A worker that can't start (or crashed): plain diffs from now on.
      failed = true;
      for (const done of waiting.values()) done(null);
      waiting.clear();
    };
  }
  const id = ++seq;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    worker!.postMessage({ id, lang, texts });
  });
}

/** Highlighted texts, by language and text, the most recently used last (a few hundred hunks' worth). */
const cache = new Map<string, Run[][]>();
const CACHE_SIZE = 600;
const cacheKey = (lang: string, text: string) => `${lang}\0${text}`;
function cached(lang: string, text: string) {
  const k = cacheKey(lang, text);
  const v = cache.get(k);
  if (v) {
    cache.delete(k);
    cache.set(k, v);
  }
  return v;
}

/** The file's lines' runs, if every one of its texts has been highlighted already. */
function fromCache(file: FileDiff, lang: string): FileRuns | null {
  const { texts, at } = sidesOf(file);
  const done = texts.map((t) => (t ? cached(lang, t) : []));
  if (done.some((d) => !d)) return null;
  return at.map((lines) => lines.map(([t, l]) => done[t]![l]));
}

/** Highlights the texts of a file's that aren't yet. Resolves false if they couldn't be. */
async function highlightFile(file: FileDiff, lang: string): Promise<boolean> {
  const todo = [...new Set(sidesOf(file).texts.filter((t) => t && !cached(lang, t)))];
  if (!todo.length) return true;
  const lines = await call(lang, todo);
  if (!lines) return false;
  todo.forEach((t, i) => cache.set(cacheKey(lang, t), lines[i]));
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return true;
}

/** A style index as CSS (the same object each time, so lines that don't change don't re-render their runs). */
export function runStyle(i: number): CSSProperties | undefined {
  if (css[i]) return css[i];
  const s = styles[i];
  if (!s) return undefined;
  const [color, fs] = s.split("|");
  const f = +fs || 0;
  return (css[i] = { color, fontStyle: f & 1 ? "italic" : undefined, fontWeight: f & 2 ? 600 : undefined });
}

/**
 * A file's highlighted lines, once they're ready (null until then, and for a file that isn't highlighted).
 * Nothing's asked of the worker until `on` (a file scrolled into view, say).
 */
export function useHighlight(file: FileDiff | null, on = true): FileRuns | null {
  const lang = useMemo(() => (file ? highlightable(file) : null), [file]);
  const [ready, setReady] = useState(0);
  const runs = useMemo(() => (file && lang ? fromCache(file, lang) : null), [file, lang, ready]);
  useEffect(() => {
    if (!file || !lang || !on || runs) return;
    let stale = false;
    void highlightFile(file, lang).then((ok) => ok && !stale && setReady((n) => n + 1));
    return () => {
      stale = true;
    };
  }, [file, lang, on, runs]);
  return runs;
}
