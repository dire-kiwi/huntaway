import { assert, describe, it } from "@effect/vitest"
import { actSummary, newestFirst, sessionEnv, sessionKind, unsafeArchivePath } from "./cua.ts"

// Computer use's plain parts: the graphical session the driver is given, the journal's summaries, the install's checks.

describe("the driver's session", () => {
  it("fills a service's missing session from systemd's environment, else a Wayland socket, and turns Wayland on", () => {
    const systemd = "DISPLAY=:0\nWAYLAND_DISPLAY=wayland-1\nHOME=/elsewhere\nXDG_SESSION_TYPE=wayland\nbroken"
    assert.deepStrictEqual(sessionEnv({ XDG_SESSION_TYPE: "x11" }, true, systemd, []), {
      DISPLAY: ":0",
      WAYLAND_DISPLAY: "wayland-1",
      XDG_SESSION_TYPE: "x11",
      CUA_DRIVER_RS_ENABLE_WAYLAND: "1",
    })
    assert.deepStrictEqual(sessionEnv({}, true, "", ["bus", "wayland-0.lock", "wayland-0"]), {
      WAYLAND_DISPLAY: "wayland-0",
      CUA_DRIVER_RS_ENABLE_WAYLAND: "1",
    })
    // A session it has is kept, and nothing is looked for off Linux.
    assert.deepStrictEqual(sessionEnv({ DISPLAY: ":1" }, true, "WAYLAND_DISPLAY=wayland-1", []), { DISPLAY: ":1" })
    assert.deepStrictEqual(sessionEnv({}, false, "DISPLAY=:0", ["wayland-0"]), {})
    assert.deepStrictEqual(
      [sessionKind({ WAYLAND_DISPLAY: "w" }, "linux"), sessionKind({ DISPLAY: ":0" }, "linux"), sessionKind({}, "linux"), sessionKind({}, "darwin")],
      ["wayland", "x11", null, "macos"],
    )
  })
})

describe("the journal's summaries", () => {
  it("say what an act does, a few steps of it", () => {
    assert.strictEqual(
      actSummary([
        { tool: "type_text", args: { text: "hi" } },
        { tool: "press_key", args: { key: "return" } },
      ]),
      'type "hi", press return',
    )
    assert.strictEqual(
      actSummary([
        { tool: "hotkey", args: { keys: ["ctrl", "s"] } },
        { tool: "set_value", args: { value: 3 } },
      ]),
      'press ctrl+s, set "3"',
    )
    assert.strictEqual(
      actSummary([{ tool: "click" }, { tool: "double_click" }, { tool: "scroll" }, { tool: "drag" }, { tool: "move_cursor" }]),
      "click, double click, scroll, drag, … (5 steps)",
    )
    assert.strictEqual(actSummary([]), "no steps")
  })
})

describe("installing", () => {
  it("refuses archives with absolute paths or .. in them, and keeps the newest version first", () => {
    assert.isUndefined(unsafeArchivePath("./\n./cua-driver\n./lib/x.so"))
    assert.strictEqual(unsafeArchivePath("./cua-driver\n../evil"), "../evil")
    assert.strictEqual(unsafeArchivePath("/etc/passwd"), "/etc/passwd")
    assert.deepStrictEqual(newestFirst(["0.9.0", "0.10.1", "0.10.0"]), ["0.10.1", "0.10.0", "0.9.0"])
  })
})
