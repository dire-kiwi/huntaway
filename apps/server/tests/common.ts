// Port of server/tests/common/mod.rs: helpers for the integration tests.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { temp_dir } from "../src/testing.ts";

/** The server's command (Cargo's `CARGO_BIN_EXE_huntaway`): `server-ts/bin/huntaway`. */
export const HUNTAWAY = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "huntaway");

/** A fixture's path in `tests/fixtures` (Rust's `include_str!("fixtures/…")`). */
export function fixture(name: string): string {
  return join(dirname(fileURLToPath(import.meta.url)), "fixtures", name);
}

/** A new, empty folder for a test, removed when the test file's tests end (`TempDir::new`). */
export function TempDir_new(prefix: string): string {
  const dir = join(temp_dir(), prefix);
  mkdirSync(dir);
  return dir;
}
