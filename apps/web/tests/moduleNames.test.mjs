// tsc on a case-insensitive disk (the macOS release build) treats Foo.tsx and foo.ts as one module and fails, so no folder
// may hold two modules whose names differ only in case, with or without the extension.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";

test("no two modules in a folder have names that differ only in case", () => {
  const clashes = [];
  const root = new URL("../src/", import.meta.url);
  const byKey = new Map();
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
    const base = entry.name.replace(/\.tsx?$/, "").replace(/\.d$/, "");
    const key = `${entry.parentPath}/${base.toLowerCase()}`;
    const names = byKey.get(key) ?? new Set();
    names.add(base);
    byKey.set(key, names);
  }
  for (const [key, names] of byKey) if (names.size > 1) clashes.push(`${key}: ${[...names].join(", ")}`);
  assert.deepEqual(clashes, []);
});
