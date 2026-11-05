// The examples in examples/, for the tests: agent-threads' spec/examples (main 5ad670a), without `raw` and the thread's
// `run`, which Huntaway's model leaves out.
import { readFileSync } from "node:fs";

const example = (name: string) => readFileSync(new URL(`examples/${name}`, import.meta.url), "utf8");

export const read_json = (name: string): any => JSON.parse(example(name));

export const read_jsonl = (name: string): any[] =>
  example(name)
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
