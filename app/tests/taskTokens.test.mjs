import assert from "node:assert/strict";
import { test } from "node:test";
import { allValues, codeRanges, completionAt, findTokens, insertCompletion, lastValue, placeWords, removeTokens, resolveTokens, stripTokens } from "../src/taskTokens.ts";

const vocab = { "/": ["task", "plan", "scratch"], "@": ["IA", "SD", "group", "none"], "!": ["opus", "sonnet"], "^": ["high"], "#": ["IA-212", "IA-216"] };
const parse = (text) => resolveTokens(findTokens(text), vocab);
const words = (tokens) => tokens.map((t) => `${t.prefix}${t.word}${t.value === undefined ? "?" : ""}`);

test("finds known tokens anywhere in the text, by any case, and the last of a kind wins", () => {
  const tokens = parse("/plan @sd Add a health check.\nThen !Sonnet ^high #IA-216 and #ia-212, /task");
  assert.deepEqual(words(tokens), ["/plan", "@sd", "!Sonnet", "^high", "#IA-216", "#ia-212", "/task"]);
  assert.equal(lastValue(tokens, "@"), "SD");
  assert.equal(lastValue(tokens, "!"), "sonnet");
  assert.equal(lastValue(tokens, "/"), "task");
  assert.deepEqual(allValues(tokens, "#"), ["IA-216", "IA-212"]);
  assert.equal(lastValue(tokens, "^"), "high");
  assert.deepEqual(tokens[0], { prefix: "/", word: "plan", start: 0, end: 5, value: "plan" });
});

test("unknown tokens have no value and set nothing", () => {
  const tokens = parse("Ask @XYZ about #123 and !gpt");
  assert.deepEqual(words(tokens), ["@XYZ?", "#123?", "!gpt?"]);
  assert.equal(lastValue(tokens, "@"), undefined);
  assert.deepEqual(allValues(tokens, "#"), []);
});

test("markdown headings, mentions, paths, links and words with a prefix in them aren't tokens", () => {
  const text = "# Heading\n## Plan\n#  IA-212\nmail me@sd.com, see https://x.io/plan and /home/me/plan, a/plan, @IA/x, !opus[1m]";
  assert.deepEqual(words(parse(text)), []);
  // A full stop, comma or bracket after one ends it.
  assert.deepEqual(words(parse("Wait for #IA-212. Then (@IA) in @SD, !opus!")), ["#IA-212", "@SD", "!opus"]);
});

test("nothing in a code span or fenced code block is a token", () => {
  const text = "Run `/plan @IA` and ``a ` /plan`` then\n```sh\n/plan @IA\n```\n~~~\n!opus\n~~~\n/plan for real";
  assert.deepEqual(words(parse(text)), ["/plan"]);
  assert.equal(parse(text)[0].start, text.lastIndexOf("/plan"));
  // An unclosed fence runs to the end; an unclosed backtick is just a backtick.
  assert.deepEqual(words(parse("```\n/plan")), []);
  assert.deepEqual(words(parse("a ` /plan")), ["/plan"]);
  // A code span doesn't run across a blank line.
  assert.deepEqual(words(parse("a `x\n\n/plan `")), ["/plan"]);
  assert.deepEqual(codeRanges("x `y` z"), [[2, 5]]);
});

test("stripping removes known tokens and tidies the space they leave", () => {
  const strip = (text) => stripTokens(text, parse(text));
  assert.equal(strip("/plan @SD Add a health check, !sonnet then ^high check it. #IA-216 "), "Add a health check, then check it.");
  assert.equal(strip("/plan @SD\n\nAdd a check\n\n!sonnet #IA-216\n\nAnd more"), "Add a check\n\nAnd more");
  assert.equal(strip("Fix it\n  - item #IA-212\n  - other"), "Fix it\n  - item\n  - other");
  // Unknown ones and text in code stay.
  assert.equal(strip("Ask @XYZ about `/plan` /plan"), "Ask @XYZ about `/plan`");
  // Without tokens, the text is left as it is.
  assert.equal(strip("  indented\n\n"), "  indented\n\n");
  // A description of nothing but tokens is empty.
  assert.equal(strip(" /plan @SD \n"), "");
});

test("removing one kind of token leaves the others", () => {
  const text = "/plan @SD Add a check !sonnet";
  assert.equal(
    removeTokens(
      text,
      parse(text).filter((t) => t.prefix === "@"),
    ),
    "/plan Add a check !sonnet",
  );
});

test("completes the token at the caret, outside code", () => {
  assert.deepEqual(completionAt("Do it @S", 8), { prefix: "@", query: "S", start: 6, end: 8 });
  assert.deepEqual(completionAt("/", 1), { prefix: "/", query: "", start: 0, end: 1 });
  // The caret in the middle of the word: it's completed as a whole.
  assert.deepEqual(completionAt("x #IA-21 y", 5), { prefix: "#", query: "IA", start: 2, end: 8 });
  assert.equal(completionAt("# Heading", 2), null);
  assert.equal(completionAt("me@sd", 5), null);
  assert.equal(completionAt("`x @S`", 5), null);
  assert.equal(completionAt("```\n@S", 6), null);

  assert.deepEqual(insertCompletion("Do it @S", { start: 6, end: 8 }, "@", "SD"), { text: "Do it @SD ", caret: 10 });
  assert.deepEqual(insertCompletion("a @S b", { start: 2, end: 4 }, "@", "SD"), { text: "a @SD b", caret: 6 });
  assert.deepEqual(insertCompletion("a @S\nb", { start: 2, end: 4 }, "@", "SD"), { text: "a @SD \nb", caret: 6 });
});

test("code in lists and quotes, and indented code, isn't tokens", () => {
  assert.deepEqual(words(parse("- ```sh\n  /plan !sonnet\n  ```\n- then /plan")), ["/plan"]);
  assert.deepEqual(words(parse("> ```\n> !sonnet\n> ```\n\n> and `^high` ^high")), ["^high"]);
  assert.deepEqual(words(parse("Text\n\n    /plan in indented code\n\n!opus")), ["!opus"]);
  const text = "- ```sh\n  /plan !sonnet\n  ```\n/plan";
  assert.equal(stripTokens(text, parse(text)), "- ```sh\n  /plan !sonnet\n  ```");
});

test("@ words: a project's key, or its key and host or profile where that's ambiguous or reserved", () => {
  const p = (key, host = "desktop", profile = "personal") => ({ key, host, profile });
  assert.deepEqual(placeWords([p("IA"), p("SD")], ["none", "group"]), ["IA", "SD"]);
  // A key that's a reserved word is qualified, so @none is always no project.
  assert.deepEqual(placeWords([p("NONE"), p("Group", "My Laptop")], ["none", "group"]), ["NONE.desktop", "Group.my-laptop"]);
  // The same key on two hosts, or in two profiles on one host.
  assert.deepEqual(placeWords([p("IA"), p("IA", "laptop")], []), ["IA.desktop", "IA.laptop"]);
  assert.deepEqual(placeWords([p("IA"), p("ia", "desktop", "work")], []), ["IA.personal", "ia.work"]);
  assert.deepEqual(placeWords([p("IA"), p("IA")], []), ["IA.desktop.personal.1", "IA.desktop.personal.2"]);
  // Qualified words are tokens, and @IA alone isn't one of them.
  const vocab = { "@": ["IA.desktop", "IA.laptop"] };
  assert.deepEqual(resolveTokens(findTokens("@ia.laptop and @IA"), vocab).map((t) => t.value), ["IA.laptop", undefined]);
});
