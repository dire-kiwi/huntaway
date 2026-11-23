#!/usr/bin/env node
// Writes one replay prompt per row of evals/review/rows.json, for a reviewer run by hand (evals/review/README.md).
//   node scripts/review-eval-render.mjs --instructions <file> --clones <dir> --out <dir> [--row <key>]
// <clones>/<key> is the row's checkout (review-eval-checkout.sh); the prompts go to <out>/<key>.prompt.md and each
// tells its reviewer to write <out>/<key>.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

const evals = join(dirname(fileURLToPath(import.meta.url)), "../evals/review")
const { values } = parseArgs({
  options: { instructions: { type: "string" }, clones: { type: "string" }, out: { type: "string" }, row: { type: "string" } },
})
if (values.instructions === undefined || values.clones === undefined || values.out === undefined) {
  console.error("usage: review-eval-render.mjs --instructions <file> --clones <dir> --out <dir> [--row <key>]")
  process.exit(2)
}
const template = readFileSync(join(evals, "prompts/replay.md"), "utf8")
const instructions = readFileSync(values.instructions, "utf8").trim()
const out = resolve(values.out)
mkdirSync(out, { recursive: true })
for (const row of JSON.parse(readFileSync(join(evals, "rows.json"), "utf8"))) {
  if (values.row !== undefined && values.row !== row.key) continue
  const facts = {
    ...row,
    base: row.base.slice(0, 9),
    commit: row.commit.slice(0, 9),
    checkout: join(resolve(values.clones), row.key),
    report: join(out, `${row.key}.json`),
    instructions,
  }
  // One pass, so text put in (a description, the instructions) is never read as a placeholder.
  const prompt = template.replace(/\{\{(\w+)\}\}/g, (whole, name) => facts[name] ?? whole)
  writeFileSync(join(out, `${row.key}.prompt.md`), prompt)
}
