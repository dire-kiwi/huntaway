// The Changes tab's highlighter (see highlight.ts): Shiki with its JavaScript regex engine (no WebAssembly), and a
// theme in the board's own colours. Each message is a language and some texts; the answer is each text's lines as
// runs of [length, style], and the styles so far.
import { createHighlighterCore, type HighlighterCore, type LanguageRegistration, type ThemeRegistration } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

type Grammar = () => Promise<{ default: LanguageRegistration[] }>;
// One chunk each, fetched when first needed (the languages highlight.ts's langFor gives).
const GRAMMARS: Record<string, Grammar> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  less: () => import("shiki/langs/less.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  fish: () => import("shiki/langs/fish.mjs"),
  powershell: () => import("shiki/langs/powershell.mjs"),
  docker: () => import("shiki/langs/docker.mjs"),
  make: () => import("shiki/langs/make.mjs"),
  just: () => import("shiki/langs/just.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
  svelte: () => import("shiki/langs/svelte.mjs"),
  astro: () => import("shiki/langs/astro.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  ini: () => import("shiki/langs/ini.mjs"),
  graphql: () => import("shiki/langs/graphql.mjs"),
  proto: () => import("shiki/langs/proto.mjs"),
  elixir: () => import("shiki/langs/elixir.mjs"),
  haskell: () => import("shiki/langs/haskell.mjs"),
  scala: () => import("shiki/langs/scala.mjs"),
  dart: () => import("shiki/langs/dart.mjs"),
  zig: () => import("shiki/langs/zig.mjs"),
  nix: () => import("shiki/langs/nix.mjs"),
  terraform: () => import("shiki/langs/terraform.mjs"),
  hcl: () => import("shiki/langs/hcl.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  r: () => import("shiki/langs/r.mjs"),
  julia: () => import("shiki/langs/julia.mjs"),
  clojure: () => import("shiki/langs/clojure.mjs"),
  perl: () => import("shiki/langs/perl.mjs"),
  elm: () => import("shiki/langs/elm.mjs"),
  solidity: () => import("shiki/langs/solidity.mjs"),
  cmake: () => import("shiki/langs/cmake.mjs"),
  groovy: () => import("shiki/langs/groovy.mjs"),
  prisma: () => import("shiki/langs/prisma.mjs"),
  nginx: () => import("shiki/langs/nginx.mjs"),
  dotenv: () => import("shiki/langs/dotenv.mjs"),
};

/** Lines longer than this (minified code) are left whole, in the default colour. */
const MAX_LINE_LENGTH = 1000;
const FG = "#c9c9d6";
// The board's palette (index.css): its violet accent for keywords, its blues, teal and pinks for the rest, and
// comments as faint as its faint text. Strings are a warm sand, so they don't read as the diff's added lines.
const THEME: ThemeRegistration = {
  name: "huntaway",
  type: "dark",
  fg: FG,
  bg: "#0b0b0e",
  settings: [
    { settings: { foreground: FG } },
    { scope: ["comment", "punctuation.definition.comment", "string.comment"], settings: { foreground: "#6e6e82", fontStyle: "italic" } },
    {
      scope: ["keyword", "storage", "storage.type", "storage.modifier", "keyword.control", "keyword.operator.new", "keyword.operator.expression", "keyword.operator.word", "variable.language", "support.type.object.module"],
      settings: { foreground: "#b49cff" },
    },
    { scope: ["keyword.operator", "punctuation", "meta.brace", "punctuation.separator", "punctuation.terminator", "punctuation.accessor"], settings: { foreground: "#8e8ea6" } },
    { scope: ["string", "punctuation.definition.string", "string.template", "markup.inline.raw", "markup.raw", "markup.fenced_code"], settings: { foreground: "#e0c08c" } },
    { scope: ["constant.character.escape", "string.regexp", "constant.other.character-class.regexp", "constant.other.placeholder"], settings: { foreground: "#f5c26b" } },
    {
      scope: ["constant.numeric", "constant.language", "support.constant", "constant.other", "variable.other.constant", "variable.other.enummember", "constant.character"],
      settings: { foreground: "#f5a97f" },
    },
    {
      scope: ["entity.name.function", "support.function", "variable.function", "entity.name.method", "meta.function-call.generic", "entity.name.function.macro", "support.function.macro"],
      settings: { foreground: "#82aaff" },
    },
    {
      scope: ["entity.name.type", "entity.name.class", "support.type", "support.class", "entity.other.inherited-class", "entity.name.namespace", "entity.name.module", "storage.type.primitive", "entity.name.type.primitive", "entity.name.scope-resolution"],
      settings: { foreground: "#6fd3d3" },
    },
    {
      scope: ["variable.other.property", "variable.other.object.property", "support.variable.property", "meta.object-literal.key", "support.type.property-name", "entity.name.tag.yaml", "variable.other.member", "entity.other.attribute-name.class.css"],
      settings: { foreground: "#b3bce6" },
    },
    { scope: ["entity.name.tag", "punctuation.definition.tag", "support.class.component"], settings: { foreground: "#f38ba8" } },
    { scope: ["entity.other.attribute-name"], settings: { foreground: "#c4a7e7" } },
    { scope: ["meta.decorator", "punctuation.decorator", "entity.name.function.decorator", "meta.attribute", "entity.name.lifetime", "storage.modifier.lifetime", "punctuation.definition.annotation"], settings: { foreground: "#f5c26b" } },
    { scope: ["markup.heading", "entity.name.section", "markup.heading punctuation.definition.heading"], settings: { foreground: "#8f8ff9", fontStyle: "bold" } },
    { scope: ["markup.bold"], settings: { fontStyle: "bold" } },
    { scope: ["markup.italic"], settings: { fontStyle: "italic" } },
    { scope: ["markup.underline.link", "string.other.link", "markup.link"], settings: { foreground: "#7c7cf8" } },
    { scope: ["markup.list punctuation.definition.list", "markup.quote"], settings: { foreground: "#9a9aab" } },
    { scope: ["markup.inserted"], settings: { foreground: "#6ee7b7" } },
    { scope: ["markup.deleted"], settings: { foreground: "#fca5a5" } },
    { scope: ["meta.diff.header", "meta.diff.range"], settings: { foreground: "#7c7cf8" } },
    { scope: ["invalid", "invalid.illegal"], settings: { foreground: "#f87171" } },
  ],
};

// A worker's global scope, which the DOM's types don't have.
const scope = self as unknown as { postMessage(message: unknown): void; onmessage: ((e: MessageEvent) => void) | null };

let highlighter: Promise<HighlighterCore> | null = null;
const loaded = new Map<string, Promise<void>>();
const styles: string[] = [];
const styleIds = new Map<string, number>();
/** A style's index: 0 is the default colour, plain. */
const styleId = (color: string | undefined, fontStyle: number | undefined) => {
  const k = `${(color ?? FG).toLowerCase()}|${fontStyle && fontStyle > 0 ? fontStyle : 0}`;
  let i = styleIds.get(k);
  if (i === undefined) {
    styleIds.set(k, (i = styles.length));
    styles.push(k);
  }
  return i;
};

styleId(FG, 0);

scope.onmessage = async (e: MessageEvent<{ id: number; lang: string; texts: string[] }>) => {
  const { id, lang, texts } = e.data;
  try {
    const grammar = GRAMMARS[lang];
    if (!grammar) throw new Error(`no grammar for ${lang}`);
    const h = await (highlighter ??= createHighlighterCore({ themes: [THEME], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) }));
    if (!loaded.has(lang)) loaded.set(lang, grammar().then((m) => h.loadLanguage(m.default)));
    await loaded.get(lang);
    const lines = texts.map((text) =>
      h.codeToTokensBase(text, { lang, theme: "huntaway", tokenizeMaxLineLength: MAX_LINE_LENGTH, tokenizeTimeLimit: 200 }).map((line) => {
        // Tokens next to each other in the same style as one run.
        const runs: [number, number][] = [];
        for (const t of line) {
          const style = styleId(t.color, t.fontStyle);
          const last = runs.at(-1);
          if (last && last[1] === style) last[0] += t.content.length;
          else runs.push([t.content.length, style]);
        }
        return runs;
      }),
    );
    scope.postMessage({ id, lines, styles });
  } catch {
    // Left plain.
    scope.postMessage({ id });
  }
};
