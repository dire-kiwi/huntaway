import assert from "node:assert/strict";
import { test } from "node:test";
import { isWholePage } from "../src/planTheme.ts";

test("a plan that's a whole page of its own is told apart from content for the theme", () => {
  assert.ok(isWholePage("<!doctype html>\n<html><body><h1>Plan</h1></body></html>"));
  assert.ok(isWholePage("  <!DOCTYPE html><h1>Plan</h1>"));
  assert.ok(isWholePage('<html lang="en"><h1>Plan</h1>'));
  assert.ok(isWholePage("<!-- written by the agent -->\n<!doctype html><h1>Plan</h1>"));
  assert.ok(!isWholePage("<h1>Plan</h1>\n<ia-lede>Summary</ia-lede>"));
  assert.ok(!isWholePage("<h1>About <html> tags</h1>"));
  assert.ok(!isWholePage("<!-- a note --><h1>Plan</h1>"));
  assert.ok(!isWholePage("<htmlish>x</htmlish>"));
});
