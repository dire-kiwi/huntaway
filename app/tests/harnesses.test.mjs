import assert from "node:assert/strict";
import { test } from "node:test";
import { harnessesOf, harnessWords } from "../src/harnesses.ts";

const claude = (id, name) => ({ id, name, agent: "claude", models: [{ id: "opus", label: "Opus" }, { id: "sonnet", label: "Sonnet" }] });
const codex = { id: "cx", name: "Codex", agent: "codex", models: [{ id: "gpt-5.5", label: "GPT-5.5" }] };
const word = (words, w) => words.find((x) => x.word === w)?.harness;

test("one config: its models and the default, as before", () => {
  const words = harnessWords([claude("a", "Personal")], "a", "default");
  assert.deepEqual(
    words.map((w) => [w.word, w.label]),
    [
      ["default", "Default model"],
      ["opus", "Opus"],
      ["sonnet", "Sonnet"],
    ],
  );
  assert.deepEqual(harnessesOf(words, ["Opus", "sonnet", "opus"]), [
    { config: "a", model: "opus" },
    { config: "a", model: "sonnet" },
  ]);
});

test("another agent's models name its config, and its name alone its default model", () => {
  const words = harnessWords([claude("a", "Personal"), codex], "a", "default");
  assert.deepEqual(word(words, "opus"), { config: "a", model: "opus" });
  assert.deepEqual(word(words, "gpt-5.5"), { config: "cx", model: "gpt-5.5" });
  assert.deepEqual(word(words, "codex"), { config: "cx", model: "" });
  assert.deepEqual(word(words, "personal"), { config: "a", model: "" });
  assert.equal(words.find((w) => w.word === "gpt-5.5").label, "GPT-5.5 · Codex");
  // Picking Codex in the dialog makes its models the plain ones, and `default` its default.
  assert.deepEqual(word(harnessWords([claude("a", "Personal"), codex], "cx", "default"), "default"), { config: "cx", model: "" });
  assert.deepEqual(harnessesOf(words, ["opus", "gpt-5.5", "codex", "nope"]), [
    { config: "a", model: "opus" },
    { config: "cx", model: "gpt-5.5" },
    { config: "cx", model: "" },
  ]);
});

test("a model two configs have is the picked config's, and either one's by its name after a dot", () => {
  const configs = [claude("a", "Personal"), claude("b", "Work login")];
  const words = harnessWords(configs, "b", "default");
  assert.deepEqual(word(words, "opus"), { config: "b", model: "opus" });
  assert.deepEqual(word(words, "opus.personal"), { config: "a", model: "opus" });
  assert.deepEqual(word(words, "opus.work-login"), { config: "b", model: "opus" });
  assert.deepEqual(word(words, "work-login"), { config: "b", model: "" });
  // The same harness named twice is one task.
  assert.deepEqual(harnessesOf(words, ["opus", "opus.work-login", "opus.personal"]), [
    { config: "b", model: "opus" },
    { config: "a", model: "opus" },
  ]);
});

test("configs with the same name are numbered, and a model's id wins over a config's name", () => {
  const configs = [claude("a", "Claude"), claude("b", "Claude"), { id: "c", name: "Opus", agent: "claude", models: [] }];
  const words = harnessWords(configs, "a", "default");
  assert.deepEqual(word(words, "claude-1"), { config: "a", model: "" });
  assert.deepEqual(word(words, "claude-2"), { config: "b", model: "" });
  assert.deepEqual(word(words, "opus.claude-2"), { config: "b", model: "opus" });
  assert.deepEqual(word(words, "opus"), { config: "a", model: "opus" });
  assert.equal(new Set(words.map((w) => w.word.toLowerCase())).size, words.length);
});

test("no configs (the agent's default): nothing to pick", () => {
  assert.deepEqual(harnessWords([], "", "default"), []);
});

test("a model is named with its config too when another config of its agent may have it", () => {
  const work = { ...codex, id: "w", name: "Work" };
  // Personal's models aren't in yet.
  const personal = { ...codex, id: "p", name: "Personal", models: [] };
  const words = harnessWords([work, personal, claude("a", "Claude")], "w", "default");
  assert.deepEqual(word(words, "gpt-5.5"), { config: "w", model: "gpt-5.5" });
  assert.deepEqual(word(words, "gpt-5.5.work"), { config: "w", model: "gpt-5.5" });
  // The only Claude config: its models need no qualifying.
  assert.equal(word(words, "opus.claude"), undefined);
});

const listed = (id) => ({ id, label: id });
test("Codex family aliases use the newest numbered release, regardless of catalog order", () => {
  const models = [
    "gpt-6-sol", "gpt-6.2-sol", "gpt-6.10-sol", "gpt-6.1-sol", "gpt-7-sol-preview",
    "gpt-6-astra", "gpt-6.1-terra", "gpt-6-luna", "gpt-6.1-sol-mini",
  ].map(listed);
  const words = harnessWords([{ ...codex, models }], "cx", "default");
  for (const [alias, model] of [["sol", "gpt-6.10-sol"], ["astra", "gpt-6-astra"], ["terra", "gpt-6.1-terra"], ["luna", "gpt-6-luna"]]) {
    assert.deepEqual(word(words, alias), { config: "cx", model });
    assert.ok(words.find((w) => w.word === alias).label.includes(model));
  }
  assert.deepEqual(harnessesOf(words, ["SOL", "gpt-6.10-sol"]), [{ config: "cx", model: "gpt-6.10-sol" }]);
  assert.deepEqual(word(words, "gpt-6-sol"), { config: "cx", model: "gpt-6-sol" });
  const newer = harnessWords([{ ...codex, models: [...models, listed("gpt-7-sol")] }], "cx", "default");
  assert.equal(word(newer, "sol").model, "gpt-7-sol");
});

test("aliases only exist for available Codex families", () => {
  for (const config of [
    { ...codex, models: [] },
    { ...codex, models: ["gpt-7-sol-preview", "gpt-7-sol-mini"].map(listed) },
    { ...claude("a", "Claude"), models: [listed("gpt-6-sol")] },
  ]) {
    const words = harnessWords([config], config.id, "default");
    assert.equal(word(words, "sol"), undefined);
    assert.equal(word(words, "luna"), undefined);
  }
});

test("aliases select and qualify configs just like full model ids", () => {
  const work = { ...codex, id: "w", name: "Work", models: [listed("gpt-6-sol")] };
  const personal = { ...codex, id: "p", name: "Personal", models: [listed("gpt-6.1-sol")] };
  const words = harnessWords([work, personal], "w", "default");
  assert.deepEqual(word(words, "sol"), { config: "w", model: "gpt-6-sol" });
  assert.deepEqual(word(words, "sol.personal"), { config: "p", model: "gpt-6.1-sol" });
  assert.deepEqual(word(words, "sol.work"), { config: "w", model: "gpt-6-sol" });
  assert.deepEqual(word(harnessWords([work, personal], "p", "default"), "sol"), { config: "p", model: "gpt-6.1-sol" });
  assert.deepEqual(word(harnessWords([work, { ...personal, models: [] }], "p", "default"), "sol.work"),
    { config: "w", model: "gpt-6-sol" });
});
