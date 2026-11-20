import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
import { systemChrome } from "@huntaway/testing"
import { pageOf, str } from "./cdp.ts"
import { startChrome } from "./chrome.ts"
import { click, evaluate, history, navigate, pageInfo, preparePage, press, screenshot, scroll, snapshot, type } from "./page.ts"
import { parseRef } from "./snapshot.ts"

// The agent's actions on a real page, in this machine's Chromium (skipped where there's none).

const FORM_HTML = `<!doctype html><title>Form</title>
<h1>Sign up</h1>
<label>Name <input id="name" value="old"></label>
<button onclick="document.title = 'Hello ' + document.getElementById('name').value">Greet</button>
<a href="second.html">Next page</a>
<div style="height: 3000px"></div><p id="end">The end</p>`

/** A fresh Chromium page, prepared, for the body (with the form's file:// address); closed after. */
const withPage = <A, E>(body: (page: ReturnType<typeof pageOf>, form: string) => Effect.Effect<A, E>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${dir}/form.html`, FORM_HTML)
      yield* fs.writeFileString(`${dir}/second.html`, "<title>Second</title><p>second page</p>")
      yield* fs.makeDirectory(`${dir}/profile`)
      const chrome = yield* startChrome({ executable: systemChrome ?? "", profileDir: `${dir}/profile`, sandbox: false })
      const { targetId } = yield* chrome.cdp.send("Target.createTarget", { url: "about:blank" })
      const page = pageOf(chrome.cdp, str(yield* chrome.cdp.send("Target.attachToTarget", { targetId, flatten: true }), "sessionId"))
      yield* preparePage(page)
      return yield* body(page, `file://${dir}/form.html`)
    }),
  ).pipe(Effect.provide(NodeServices.layer))

/** The ref of the line of `outline` that has `text`. */
const refOf = (outline: string, text: string) => {
  const line = outline.split("\n").find((l) => l.includes(text)) ?? assert.fail(`no ${text} in:\n${outline}`)
  return /\[ref=(e\d+)\]/u.exec(line)?.[1] ?? assert.fail(`no ref on: ${line}`)
}

describe.skipIf(systemChrome === null)("a page", () => {
  it.live("reads as an outline with refs; clicks, types and presses keys on them", () =>
    withPage((page, FORM) =>
      Effect.gen(function* () {
        yield* navigate(page, FORM)
        const outline = yield* snapshot(page)
        assert.strictEqual(
          outline.replace(/e\d+/gu, "e"),
          [
            '- heading "Sign up" [level=1] [ref=e]',
            "- LabelText [ref=e]",
            "  - text: Name",
            '  - textbox "Name" value="old" [ref=e]',
            '- button "Greet" [ref=e]',
            '- link "Next page" [ref=e]',
            "- paragraph [ref=e]: The end",
          ].join("\n"),
        )
        assert.include(outline, '- heading "Sign up"')
        assert.include(outline, '- button "Greet"')
        assert.include(outline, '- link "Next page"')
        assert.match(outline, /textbox "Name" value="old"/u)
        yield* type(page, refOf(outline, 'textbox "Name"'), "Ada", true, false)
        yield* click(page, refOf(outline, 'button "Greet"'))
        assert.strictEqual((yield* pageInfo(page)).title, "Hello Ada")
        // A click that navigates waits for the new page.
        yield* click(page, refOf(outline, 'link "Next page"'))
        assert.strictEqual((yield* pageInfo(page)).title, "Second")
        yield* history(page, "back")
        assert.strictEqual((yield* pageInfo(page)).title, "Form")
        // Keys: Tab moves the focus to the input.
        yield* press(page, "Tab")
        assert.strictEqual((yield* evaluate(page, "document.activeElement.id")).text, "name")
        const refused = yield* Effect.flip(press(page, "NotAKey"))
        assert.include(refused.reason, "isn't a key")
      }),
    ),
  )

  it.live("scrolls, evaluates (with what it threw), and takes a picture", () =>
    withPage((page, FORM) =>
      Effect.gen(function* () {
        yield* navigate(page, FORM)
        yield* scroll(page, undefined, 0, 1000)
        assert.isAbove(Number((yield* evaluate(page, "Math.round(scrollY)")).text), 0)
        const outline = yield* snapshot(page)
        yield* scroll(page, refOf(outline, "The end"), 0, 0)
        assert.isTrue((yield* evaluate(page, "document.getElementById('end').getBoundingClientRect().top < innerHeight")).text === "true")
        assert.deepStrictEqual(yield* evaluate(page, "Promise.resolve({ a: 1 })"), { ok: true, text: '{\n  "a": 1\n}' })
        const thrown = yield* evaluate(page, "nope.nope")
        assert.isFalse(thrown.ok)
        assert.include(thrown.text, "nope is not defined")
        const png = yield* screenshot(page)
        assert.isTrue(Buffer.from(png, "base64").subarray(1, 4).toString() === "PNG")
        // A stale or bad ref says so.
        assert.include((yield* Effect.flip(click(page, "e999999"))).reason, "take a new snapshot")
        assert.include((yield* Effect.flip(click(page, "button"))).reason, "isn't a ref")
        assert.strictEqual(parseRef("e12"), 12)
      }),
    ),
  )

  it.live("a page that can't load says why", () =>
    withPage((page) =>
      Effect.gen(function* () {
        const e = yield* Effect.flip(navigate(page, "http://127.0.0.1:2/"))
        assert.include(e.reason, "didn't load: net::ERR_")
      }),
    ),
  )
})
