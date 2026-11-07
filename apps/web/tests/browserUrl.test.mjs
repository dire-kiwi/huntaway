import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { browserUrl } from "../src/components/task/browserUrl.ts";

// HA-275: what the browser pane's address bar opens.
test("addresses typed into the browser pane", () => {
  const cases = {
    5173: "http://localhost:5173/",
    "localhost:5173": "http://localhost:5173/",
    "localhost:5173/board?x=1": "http://localhost:5173/board?x=1",
    "127.0.0.1:8080": "http://127.0.0.1:8080/",
    "192.168.1.20:3000": "http://192.168.1.20:3000/",
    "box.local": "http://box.local/",
    "example.com": "https://example.com/",
    "example.com:8443/a": "https://example.com:8443/a",
    "  https://example.com/x  ": "https://example.com/x",
    "http://example.com": "http://example.com/",
    "HTTPS://Example.com": "https://example.com/",
  };
  for (const [input, url] of Object.entries(cases)) assert.equal(browserUrl(input), url, input);
});

test("the browser pane opens only web pages", () => {
  for (const input of ["", "   ", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "chrome://gpu", "mailto:a@b.c", "two words", "about:blank"])
    assert.equal(browserUrl(input), null, input);
});
