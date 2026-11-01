import assert from "node:assert/strict";
import { test } from "node:test";
import { compareVersions } from "../src/versions.ts";

test("versions compare by semver precedence", () => {
  const sign = (a, b) => Math.sign(compareVersions(a, b));
  assert.equal(sign("0.10.0", "0.9.0"), 1);
  assert.equal(sign("v0.2.0", "0.2.0"), 0);
  assert.equal(sign("0.2.0", "0.2.0-rc.1"), 1);
  assert.equal(sign("0.2.0-rc.2", "0.2.0-rc.10"), -1);
  assert.equal(sign("0.2.0-rc.1", "0.2.0-beta"), 1);
  assert.equal(sign("0.2.0-rc", "0.2.0-rc.1"), -1);
  assert.ok(Number.isNaN(compareVersions("nope", "0.1.0")));
});
