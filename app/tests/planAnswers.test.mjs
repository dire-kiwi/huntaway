import assert from "node:assert/strict";
import { test } from "node:test";
import { afterSend, answered, answersMessage, readFields, resetFields, withTouched } from "../src/planAnswers.ts";

const field = (name, label, answer, extra = {}) => ({ name, label, type: "radio", value: { v: [] }, answer, touched: false, initial: { value: { v: [] }, answer: [] }, ...extra });

test("the answers go to the agent as a list of each question with its answer, by name", () => {
  const fields = [
    field("db", "Which database?", ["SQLite"]),
    field("pages", "Which pages?", ["Home", "Other: Settings"]),
    field("notes", "Anything else?", ["Line one\nLine two"]),
    field("when", "", []),
    field("plain", "plain", ["x"]),
  ];
  assert.equal(
    answersMessage(fields, 3),
    "My answers to the questions in the plan (v3):\n\n" +
      "- Which database? (`db`): SQLite\n" +
      "- Which pages? (`pages`):\n  - Home\n  - Other: Settings\n" +
      "- Anything else? (`notes`):\n  > Line one\n  > Line two\n" +
      "- `when`: (no answer)\n" +
      "- `plain`: x\n\n" +
      "Please update the plan with them.",
  );
  assert.equal(answered(fields), 4);
  assert.match(answersMessage([field("a", "A", ["b"])]), /^My answers to the questions in the plan:\n/);
});

test("what a plan's frame reports is checked, as its scripts are the agent's", () => {
  assert.equal(readFields({ iaScroll: 3 }), null);
  assert.equal(readFields(null), null);
  const fields = readFields({
    iaForm: [
      { name: "a", label: "A?", type: "checkbox", value: { v: ["x", 4], o: "more" }, answer: ["X", "  ", 7], touched: 1 },
      { name: "", label: "no name" },
      { label: "no name" },
      "junk",
      { name: "b", value: "junk" },
    ],
  });
  assert.deepEqual(fields, [
    { name: "a", label: "A?", type: "checkbox", value: { v: ["x", ""], o: "more" }, answer: ["X"], touched: true, initial: { value: { v: [] }, answer: [] } },
    { name: "b", label: "", type: "", value: { v: [] }, answer: [], touched: false, initial: { value: { v: [] }, answer: [] } },
  ]);
  const long = readFields({ iaForm: [{ name: "t", answer: ["y".repeat(50000)] }] });
  assert.equal(long[0].answer[0].length, 20000);
});

test("touched answers are added to the saved ones, which keep questions the plan no longer has", () => {
  const saved = { gone: { v: ["a"] }, db: { v: ["pg"] } };
  const fields = [field("db", "", [], { value: { v: ["sqlite"] }, touched: true }), field("other", "", [], { value: { v: ["z"] } })];
  assert.deepEqual(withTouched(saved, fields), { gone: { v: ["a"] }, db: { v: ["sqlite"] } });
});

test("a checkbox question left with none ticked is answered (none of them), unlike one not looked at or an empty text", () => {
  const extras = field("extras", "Which extras?", [], { type: "checkbox", touched: true });
  const fields = [extras, field("later", "Later?", [], { type: "checkbox" }), field("notes", "Notes?", [], { type: "textarea", touched: true })];
  assert.equal(answered(fields), 1);
  assert.equal(answered([extras]), 1);
  assert.match(answersMessage(fields), /- Which extras\? \(`extras`\): \(none of the choices\)\n- Later\? \(`later`\): \(no answer\)\n- Notes\? \(`notes`\): \(no answer\)/);
});

test("Reset puts back the plan's own values and answers, without the frame", () => {
  const db = field("db", "", ["Postgres"], { value: { v: ["pg"] }, touched: true, initial: { value: { v: ["sqlite"] }, answer: ["SQLite"] } });
  assert.deepEqual(resetFields([db]), [{ ...db, value: { v: ["sqlite"] }, answer: ["SQLite"], touched: false }]);
});

test("after a send, answers changed while it was sent are kept, and the rest go", () => {
  const before = { a: { v: ["1"] }, b: { v: ["2"] }, gone: { v: ["x"] } };
  // b changed meanwhile, c was answered meanwhile (maybe in a view of the task opened since).
  const now = { a: { v: ["1"] }, b: { v: ["3"] }, c: { v: ["4"] }, gone: { v: ["x"] } };
  assert.deepEqual(afterSend(before, now), { answers: { b: { v: ["3"] }, c: { v: ["4"] } }, sentAsIs: ["a", "gone"] });
  // Nothing changed: nothing is left.
  assert.deepEqual(afterSend(before, before), { answers: {}, sentAsIs: ["a", "b", "gone"] });
  // Reset meanwhile: nothing to keep.
  assert.deepEqual(afterSend(before, {}), { answers: {}, sentAsIs: [] });
});
