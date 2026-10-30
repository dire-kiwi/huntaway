#!/usr/bin/env node
// Drive the web UI in headless Chromium: open pages, click, type, check and take screenshots.
//
//   node scripts/ui-check.mjs [options] <step>...      # one step per argument
//   node scripts/ui-check.mjs [options] -f steps.txt   # one step per line ("-f -" reads stdin; # starts a comment)
//
// Options:
//   --env <file|data dir>   test-server.sh's output saved to a file, or its data dir (default: $IA_TEST_DATA_DIR)
//   --url <url> --token <t> instead of --env ($IA_TEST_URL and $IA_TEST_TOKEN also work)
//   --size <w>x<h>          viewport, default 1900x1000 (the Done column is off-screen below about 1900 wide)
//   --touch                 a touch screen, as a phone or tablet has (pointer: coarse; below 700 wide is the phone layout)
//   --timeout <ms>          for each step, default 5000
//   --allow-error <regex>   don't fail on page and console errors that match (repeatable)
//   --chromium <path>       default /usr/bin/chromium
//
// Steps (a <target> is a CSS or Playwright selector if it starts with # . [ // or css= text= role= and so on,
// or tag[...]; anything else is text, matched case-insensitively against what's shown, then against
// title, aria-label and placeholder: an exact match wins over a substring one):
//   goto <path|url>            a path is taken from the server's URL; the token is already set
//   click|rclick|dblclick|hover <target>
//   type <text>                types into the focused element (click it first)
//   press <key>                Enter, Escape, Control+a, ...
//   wait <target>              until it's shown
//   gone <target>              until it isn't
//   text <target>              prints its text
//   eval <js>                  prints the result (promises are awaited)
//   assert <js>                fails unless the result is truthy
//   sleep <ms>
//   size <w>x<h>
//   shot <file> [--crop <target>] [--full]
//
// It prints page errors and console errors as they happen, and exits non-zero on a failed step (after
// saving a screenshot of the page to <tmp>/ui-check-<pid>-failed.png) or on any error that wasn't allowed.
//
// The same thing is a module for scripted checks (see app/tests/ui):
//   const ui = await open({ url, token }); await ui.run(["goto /settings", "wait Profiles"]); ui.page...; await ui.close();

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const appDir = fileURLToPath(new URL("../app/", import.meta.url));

function playwright() {
  try {
    return createRequire(appDir)("playwright-core");
  } catch {
    throw new Error(`playwright-core isn't installed; run \`npm ci\` in ${appDir}`);
  }
}

/** URL and token from test-server.sh's output (a saved file) or its data dir. */
export function readEnv(where) {
  const vars = {};
  let file = where;
  if (fs.statSync(where).isDirectory()) {
    file = path.join(where, "env");
    if (!fs.existsSync(file)) {
      // Not written by older test-server.sh: find the port in the log (the last start, after a restart).
      const log = fs.readFileSync(path.join(where, "server.log"), "utf8");
      const port = [...log.matchAll(/^IA_READY .*"port":(\d+)/gm)].pop()?.[1];
      if (!port) throw new Error(`no IA_READY line in ${where}/server.log`);
      return { url: `http://127.0.0.1:${port}`, token: fs.readFileSync(path.join(where, "auth_token"), "utf8").trim() };
    }
  }
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?(\w+)=(.*)$/);
    if (m) vars[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  if (!vars.IA_TEST_URL) throw new Error(`no IA_TEST_URL in ${file}`);
  return { url: vars.IA_TEST_URL, token: vars.IA_TEST_TOKEN ?? "" };
}

// CSS (#id, .class, [attr], tag[...], tag.class, tag:has(...), tag > ...), XPath, or a Playwright engine (css=, role=, ...).
const TAGS = "a|button|input|textarea|select|option|label|form|div|span|p|li|ul|ol|nav|main|aside|header|footer|section|article|dialog|h[1-6]|img|iframe|svg|table|tr|td|th";
const SELECTOR = new RegExp(`^(#|\\.|\\[|//|[a-z][\\w-]*=|(${TAGS})([#.[]|:[a-z]| *>))`, "i");
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const escapeCss = (s) => s.replace(/["\\]/g, "\\$&");

/**
 * Open a browser on the server. `errors` collects page and console errors that weren't allowed.
 * Options: url, token, size ("1900x1000"), touch (a touch screen), timeout (ms), allowErrors (regexes), chromium (path),
 * log (function).
 */
export async function open({ url, token = "", size = "1900x1000", touch = false, timeout = 5000, allowErrors = [], chromium = "/usr/bin/chromium", log = console.log } = {}) {
  if (!url) throw new Error("no server URL: pass --env <file|data dir>, or --url and --token (variables set with `. <env file>` aren't exported)");
  const base = url.replace(/\/+$/, "");
  const [width, height] = parseSize(size);
  const browser = await playwright().chromium.launch({ executablePath: chromium });
  const context = await browser.newContext({ viewport: { width, height }, ...(touch && { hasTouch: true, isMobile: true }) });
  // Signed in before the app's first script runs, so any page can be opened directly. Init scripts run in
  // every frame, and plans render in a sandboxed frame where touching localStorage throws: only the app's own page.
  if (token)
    await context.addInitScript(
      ([t, origin]) => {
        if (window !== window.top || location.origin !== origin) return;
        try {
          localStorage.setItem("ia.token", t);
        } catch {
          /* no storage; the app will ask to sign in */
        }
      },
      [token, new URL(base).origin],
    );
  context.setDefaultTimeout(timeout);
  context.setDefaultNavigationTimeout(Math.max(timeout, 15000));
  const page = await context.newPage();
  const errors = [];
  // The app asks every server for its open token (see fetchOpenToken), and only PR previews have one.
  const allowed = [/status of 404 .*\/api\/open-token\)$/, ...allowErrors].map((r) => (r instanceof RegExp ? r : new RegExp(r)));
  const report = (what) => {
    const ok = allowed.some((r) => r.test(what));
    log(`${what}${ok ? " (allowed)" : ""}`);
    if (!ok) errors.push(what);
  };
  page.on("pageerror", (e) => report(`pageerror: ${e.stack || e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const at = m.location()?.url;
    report(`console.error: ${m.text()}${at && !m.text().includes(at) ? ` (${at})` : ""}`);
  });
  page.on("crash", () => report("page crashed"));

  /** The first shown element that `target` matches, waiting up to the timeout. */
  async function find(target, { gone = false, quiet = gone } = {}) {
    const candidates = SELECTOR.test(target) ? [page.locator(target)] : textCandidates(page, target);
    const deadline = Date.now() + timeout;
    for (;;) {
      let match = null;
      for (const loc of candidates) {
        const shown = loc.filter({ visible: true });
        const n = await shown.count();
        if (n) {
          if (n > 1 && !quiet) log(`  note: ${n} shown elements match ${JSON.stringify(target)}; using the first (a selector, or "text=… >> nth=1", picks another)`);
          match = shown.first();
          break;
        }
      }
      if (gone ? !match : match) return match;
      if (Date.now() > deadline) throw new Error(gone ? `${JSON.stringify(target)} is still shown` : `nothing shown matches ${JSON.stringify(target)}`);
      await page.waitForTimeout(100);
    }
  }

  async function step(line) {
    const [verb, rest] = splitVerb(line);
    switch (verb) {
      case "goto":
        await page.goto(/^https?:/.test(rest) ? rest : base + (rest.startsWith("/") ? rest : `/${rest}`));
        break;
      case "click":
      case "rclick":
      case "dblclick": {
        const el = await find(rest);
        if (verb === "dblclick") await el.dblclick();
        else await el.click({ button: verb === "rclick" ? "right" : "left" });
        break;
      }
      case "hover":
        await (await find(rest)).hover();
        break;
      case "type": {
        const focused = await page.evaluate(() => {
          const el = document.activeElement;
          return !!el && el !== document.body && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.getAttribute("role") === "textbox");
        });
        if (!focused) throw new Error("nothing to type into is focused; click the field first");
        await page.keyboard.type(rest);
        break;
      }
      case "press":
        await page.keyboard.press(rest);
        break;
      case "wait":
        await find(rest, { quiet: true });
        break;
      case "gone":
        await find(rest, { gone: true });
        break;
      case "text":
        log(`  ${JSON.stringify(await (await find(rest)).innerText())}`);
        break;
      case "eval":
        log(`  ${JSON.stringify(await page.evaluate(rest))}`);
        break;
      case "assert": {
        const v = await page.evaluate(rest);
        if (!v) throw new Error(`assertion failed (got ${JSON.stringify(v)})`);
        break;
      }
      case "sleep":
        await page.waitForTimeout(Number(rest));
        break;
      case "size": {
        const [w, h] = parseSize(rest);
        await page.setViewportSize({ width: w, height: h });
        break;
      }
      case "shot": {
        const fullPage = /(^|\s)--full(\s|$)/.test(rest);
        const m = rest.replace(/(^|\s)--full(?=\s|$)/, "").trim().match(/^(\S+)(?:\s+--crop\s+(.+))?$/);
        if (!m) throw new Error("usage: shot <file> [--crop <target>] [--full]");
        const [, file, crop] = m;
        fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
        if (crop) await (await find(crop)).screenshot({ path: file });
        else await page.screenshot({ path: file, fullPage });
        log(`  saved ${path.resolve(file)}`);
        break;
      }
      default:
        throw new Error(`unknown step "${verb}"`);
    }
  }

  /** Run steps in order, stopping at the first that fails (rethrown with the step in the message). */
  async function run(steps) {
    for (const line of steps) {
      log(`> ${line}`);
      try {
        await step(line);
      } catch (e) {
        // Playwright's call log can run long; its first lines say what it was waiting on.
        e.message = `step "${line}" failed: ${e.message.split("\n").slice(0, 8).join("\n")}`;
        throw e;
      }
    }
  }

  const close = () => browser.close();
  return { browser, context, page, errors, base, find, step, run, close };
}

function textCandidates(page, text) {
  const exact = new RegExp(`^\\s*${escapeRe(text)}\\s*$`, "i");
  const attr = (op) => page.locator(["title", "aria-label", "placeholder"].map((a) => `[${a}${op}"${escapeCss(text)}" i]`).join(", "));
  return [page.getByText(exact), attr("="), page.getByText(text), attr("*=")];
}

function splitVerb(line) {
  const m = line.trim().match(/^(\S+)\s*(.*)$/s);
  if (!m) throw new Error("empty step");
  return [m[1], m[2]];
}

function parseSize(s) {
  const m = String(s).match(/^(\d+)x(\d+)$/);
  if (!m) throw new Error(`bad size "${s}"; use <width>x<height>`);
  return [Number(m[1]), Number(m[2])];
}

function parseArgs(argv) {
  const o = { allowErrors: [], steps: [] };
  const env = process.env;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--env") o.env = val();
    else if (a === "--url") o.url = val();
    else if (a === "--token") o.token = val();
    else if (a === "--size") o.size = val();
    else if (a === "--touch") o.touch = true;
    else if (a === "--timeout") o.timeout = Number(val());
    else if (a === "--allow-error") o.allowErrors.push(val());
    else if (a === "--chromium") o.chromium = val();
    else if (a === "-f") {
      const f = val();
      const text = fs.readFileSync(f === "-" ? 0 : f, "utf8");
      o.steps.push(...text.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")));
    } else if (a === "-h" || a === "--help") o.help = true;
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else o.steps.push(a);
  }
  if (!o.url) {
    const where = o.env ?? (env.IA_TEST_URL ? null : env.IA_TEST_DATA_DIR);
    const found = where ? readEnv(where) : { url: env.IA_TEST_URL, token: env.IA_TEST_TOKEN };
    o.url = found.url;
    o.token ??= found.token;
  }
  return o;
}

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  if (o.help || !o.steps.length) {
    const src = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
    const lines = src.split("\n").slice(1);
    console.log(lines.slice(0, lines.findIndex((l) => !l.startsWith("//"))).map((l) => l.slice(3)).join("\n"));
    process.exit(o.help ? 0 : 2);
  }
  let ui;
  try {
    ui = await open(o);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  let failed = false;
  try {
    await ui.run(o.steps);
  } catch (e) {
    failed = true;
    console.log(`FAIL ${e.message}`);
    const shot = path.join(os.tmpdir(), `ui-check-${process.pid}-failed.png`);
    try {
      await ui.page.screenshot({ path: shot });
      console.log(`  the page at the time: ${shot} (${ui.page.url()})`);
    } catch {
      /* the page is gone */
    }
  }
  await ui.close();
  if (ui.errors.length) console.log(`FAIL ${ui.errors.length} page/console error(s), listed above`);
  else if (!failed) console.log("ok");
  process.exit(failed || ui.errors.length ? 1 : 0);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
