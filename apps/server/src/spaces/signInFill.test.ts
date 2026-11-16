import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Redacted } from "effect"
import { TestClock } from "effect/testing"
import { LOGIN_REFS } from "@huntaway/testing"
import { carries, fillSignIn, maskUsername, originOf, pickLoginFields, scrub, shownAddress } from "./signInFill.ts"
import type { DriverCall, Fill } from "./signInFill.ts"

// The sign-in sequence (HE-48) over a scripted Cua Driver: what it types where, and what it refuses before typing.

/** With what a form encodes and `encodeURIComponent` doesn't: `!` `'` `(` `)` `~`. */
const SECRET = "s3cret Pa55&!'(~)"

/** A driver tool's answer that it did it. */
const ok = (structuredContent: Record<string, unknown>) => ({ result: { content: [], structuredContent: { status: "ok", ...structuredContent } } })

/** A driver whose one tab is at `url`, recording the calls it gets; `typeAnswer` replaces `browser_type`'s answer. */
const scripted = (url: string, typeAnswer?: unknown) => {
  const calls: Array<{ readonly tool: string; readonly args: Readonly<Record<string, unknown>> }> = []
  const tab = { url }
  const call: DriverCall = (tool, args) =>
    Effect.sync(() => {
      calls.push({ tool, args })
      switch (tool) {
        case "browser_prepare":
          return ok({ prepared_pid: 42 })
        case "list_windows":
          return ok({ windows: [{ pid: 42, window_id: 7 }] })
        case "get_browser_state":
          if (args["pid"] !== undefined) return ok({ target_id: "bt-1", tabs: [{ tab_id: "tab-1", active: true }] })
          return ok({ url: tab.url, refs: tab.url.endsWith("/login") ? LOGIN_REFS : [] })
        case "browser_navigate":
          tab.url = String(args["url"])
          return ok({})
        case "browser_type":
          return typeAnswer === undefined ? ok({}) : { result: typeAnswer }
        case "browser_click":
          // As a browser sends a GET form.
          tab.url = `${new URL(tab.url).origin}/home?${new URLSearchParams({ pw: SECRET }).toString()}#x`
          return ok({})
        default:
          return { error: `no tool ${tool}` }
      }
    })
  return { call, calls, tools: () => calls.map((c) => c.tool) }
}

const fill = (over: Partial<Fill> = {}): Fill => ({
  url: "https://login.example.test/login",
  origin: "https://login.example.test",
  username: "ada@example.test",
  password: Redacted.make(SECRET),
  fresh: "huntaway-sign-in-1",
  ...over,
})

describe("the sign-in sequence", () => {
  it("reads origins, masks usernames and scrubs a secret as typed and as encoded", () => {
    assert.strictEqual(originOf("HTTPS://Login.Example.test:443/a?b"), "https://login.example.test")
    assert.strictEqual(originOf("http://site.test:8000/x"), "http://site.test:8000")
    assert.isNull(originOf("file:///etc/passwd"))
    assert.isNull(originOf("not a url"))
    assert.strictEqual(maskUsername("ada@example.test"), "a***@example.test")
    assert.strictEqual(maskUsername("ada"), "a***")
    const form = new URLSearchParams({ p: SECRET }).toString().slice(2)
    assert.strictEqual(scrub(`a ${SECRET} b ${encodeURIComponent(SECRET)} c ${form}`, SECRET), "a *** b *** c ***")
    assert.strictEqual(scrub("pw=Passw0rd%21", "Passw0rd!"), "pw=***")
    assert.isTrue(carries("https://x.test/done?user=a&pw=its%28me%29%7E", "its(me)~"))
    assert.isTrue(carries("https://x.test/done#pw=Hunter2%21", "Hunter2!"))
    assert.isFalse(carries("https://x.test/done?user=a", "Hunter2!"))
    assert.strictEqual(shownAddress(`https://x.test/done?pw=${form}#t`, SECRET), "https://x.test/done")
  })

  it("picks the password input, the username input before it and the submit button after it", () => {
    assert.deepStrictEqual(pickLoginFields(LOGIN_REFS), {
      username: { ref: "p1:1", kind: "email" },
      password: { ref: "p1:3", kind: "password" },
      submit: "p1:5",
    })
    assert.isNull(pickLoginFields(LOGIN_REFS.slice(0, 2)))
  })

  it.effect("opens its own browser on the page, types both fields and submits; the answer has no password", () =>
    Effect.gen(function* () {
      const d = scripted("about:blank")
      const done = yield* fillSignIn(d.call, fill())
      assert.deepStrictEqual(d.tools().slice(0, 5), ["browser_prepare", "list_windows", "get_browser_state", "browser_navigate", "get_browser_state"])
      assert.deepStrictEqual(d.calls[0]?.args, { session: "huntaway-sign-in-1", allow_launch: true, profile: { mode: "isolated_new" } })
      const typed = d.calls.filter((c) => c.tool === "browser_type").map((c) => [c.args["ref"], c.args["text"], c.args["replace"]])
      assert.deepStrictEqual(typed, [
        ["p1:1", "ada@example.test", false],
        ["p1:3", SECRET, true],
      ])
      assert.strictEqual(d.calls.find((c) => c.tool === "browser_click")?.args["delivery_mode"], "foreground")
      // The tab is taken off the address the GET form put the password in.
      assert.deepStrictEqual(d.calls.at(-1), {
        tool: "browser_navigate",
        args: { session: "huntaway-sign-in-1", target_id: "bt-1", tab_id: "tab-1", url: "https://login.example.test/home" },
      })
      assert.deepStrictEqual(done, {
        origin: "https://login.example.test",
        username_hint: "a***@example.test",
        submitted: true,
        page_url: "https://login.example.test/home",
        password_in_address: true,
        session: "huntaway-sign-in-1",
        target_id: "bt-1",
        tab_id: "tab-1",
      })
    }),
  )

  it.effect("fills the caller's tab, but types nothing on another origin", () =>
    Effect.gen(function* () {
      const tab = { session: "mine", target_id: "bt-9", tab_id: "tab-9" }
      const own = scripted("https://login.example.test/login")
      assert.strictEqual((yield* fillSignIn(own.call, fill(tab))).tab_id, "tab-9")
      assert.notInclude(own.tools(), "browser_prepare")

      const look = scripted("https://login.example.test.evil.test/login")
      const running = yield* Effect.forkChild(Effect.flip(fillSignIn(look.call, fill(tab))))
      yield* TestClock.adjust("10 seconds")
      const refused = yield* Fiber.join(running)
      assert.strictEqual(refused._tag, "Invalid")
      assert.include(refused._tag === "Invalid" ? refused.reason : "", "login.example.test.evil.test")
      assert.notInclude(look.tools(), "browser_type")

      const half = yield* Effect.flip(fillSignIn(own.call, fill({ target_id: "bt-9" })))
      assert.strictEqual(half._tag, "Invalid")
    }),
  )

  it.effect("a driver refusal is told without the password", () =>
    Effect.gen(function* () {
      const refusal = { content: [{ type: "text", text: `could not type ${SECRET}` }], structuredContent: { status: "refused" }, isError: true }
      const d = scripted("https://login.example.test/login", refusal)
      const e = yield* Effect.flip(fillSignIn(d.call, fill({ session: "s", target_id: "bt-1", tab_id: "tab-1" })))
      assert.strictEqual(e._tag, "Unavailable")
      const reason = e._tag === "Unavailable" ? e.reason : ""
      assert.include(reason, "could not type ***")
      assert.notInclude(reason, "s3cret")
    }),
  )
})
