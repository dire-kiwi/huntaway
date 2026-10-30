import assert from "node:assert/strict";
import { test } from "node:test";
import { askedAnswers, declinedWithAnswers, planTitle, questionsOf, withoutTitle } from "../src/questions.ts";

test("a prompt's questions are read whatever the agent sent", () => {
  const data = {
    input: {
      questions: [
        { question: "Which?", header: "Pick", multiSelect: true, options: [{ label: "A", description: "first" }, "B", { description: "no label" }] },
        null,
        { id: "x", question: "", options: null, isOther: false, isSecret: true },
      ],
    },
  };
  assert.deepEqual(questionsOf(data), [
    { question: "Which?", header: "Pick", options: [{ label: "A", description: "first", preview: undefined }, { label: "B" }], multiSelect: true, isOther: undefined, isSecret: false },
    { question: "(no question)", header: undefined, options: [], multiSelect: false, isOther: false, isSecret: true },
  ]);
  assert.deepEqual(questionsOf({ input: { plan: "x" } }), []);
  assert.deepEqual(questionsOf(null), []);
});

test("the answers given are read once there are some", () => {
  assert.equal(askedAnswers({ status: "pending" }), undefined);
  assert.deepEqual(askedAnswers({ answers: [["A", ""], "x", []] }), [["A"], [], []]);
});

test("a host that can't pass answers to the tool declines it with them", () => {
  const questions = questionsOf({ input: { questions: [{ question: "Which?" }, { question: "And?" }] } });
  assert.equal(
    declinedWithAnswers(questions, [["A", "B"], []]),
    "The user answered your questions in the board, which couldn't pass the answers to this tool (so it shows as declined). Carry on with these answers:\n\n" +
      "- Which?\n  A, B\n- And?\n  (no answer)",
  );
});

test("a plan's title is its first heading, shown above it rather than in it", () => {
  const plan = "\n# Plan: Add a cache\n\n## Steps\n1. Do it";
  assert.equal(planTitle(plan), "Add a cache");
  assert.equal(withoutTitle(plan), "## Steps\n1. Do it");
  assert.equal(planTitle("Do it\n# Not a title"), "");
  assert.equal(withoutTitle("Do it"), "Do it");
  assert.equal(planTitle("### TES-3: Add hello.txt"), "TES-3: Add hello.txt");
});
