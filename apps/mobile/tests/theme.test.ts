/// <reference types="node" />
// HA-262: the phone showed Ready for merge green, the web board's Done colour, where the board has it pink. Its status
// colours are the board's (apps/web/src/index.css's --color-st-*).
import fs from "node:fs";
import path from "node:path";
import { STATUS_COLOR } from "../src/theme";

test("the status colours are the web board's", () => {
  const css = fs.readFileSync(path.resolve(__dirname, "../../web/src/index.css"), "utf8");
  const board = (name: string) => new RegExp(`--color-st-${name}:\\s*(#[0-9a-f]+);`, "i").exec(css)?.[1];
  const names = {
    backlog: "backlog",
    todo: "todo",
    in_progress: "progress",
    needs_attention: "attention",
    in_review: "review",
    ready_for_merge: "merge",
    done: "done",
  };
  expect(STATUS_COLOR).toEqual(Object.fromEntries(Object.entries(names).map(([status, name]) => [status, board(name)])));
});
