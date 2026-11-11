import { assert, describe, it } from "@effect/vitest"
import { parseSession, parseSessions, resize, serverArgs, sessionName, size, socketPath, socketProblem, target, tmuxEnv } from "./tmux.ts"

describe("tmux", () => {
  it("is the data folder's own server, by its socket's path, and never by a name", () => {
    const sock = socketPath("/home/u/.local/share/huntaway-effect/")
    assert.strictEqual(sock, "/home/u/.local/share/huntaway-effect/tmux.sock")
    assert.deepStrictEqual(serverArgs(sock), ["-S", sock])
    assert.isNull(socketProblem(sock))
    assert.include(socketProblem(socketPath(`/tmp/${"x".repeat(100)}`)) ?? "", "too long")
    const env = tmuxEnv({ HUNTAWAY_TOKEN: undefined })
    assert.isTrue("TMUX" in env && env["TMUX"] === undefined && "TMUX_PANE" in env && "HUNTAWAY_TOKEN" in env)
  })

  it("names a task's sessions as the old server did, and reads them back", () => {
    assert.strictEqual(sessionName("t1", null), "ia-t1")
    assert.strictEqual(sessionName("t1", "lg"), "ia-t1~lg")
    assert.strictEqual(target("t1", "lg"), "=ia-t1~lg")
    assert.deepStrictEqual(parseSession("ia-t1~lg"), { task: "t1", tool: "lg" })
    assert.deepStrictEqual(parseSession("ia-t1"), { task: "t1", tool: null })
    assert.isNull(parseSession("work"))
    assert.isNull(parseSession("ia-"))
    assert.deepStrictEqual(parseSessions("ia-t1 0\nmy session 2\n"), [
      { name: "ia-t1", attached: 0 },
      { name: "my session", attached: 2 },
    ])
  })

  it("takes sizes of 2 to 1000 from the socket's query, and clamps a resize", () => {
    assert.strictEqual(size("120", 80), 120)
    assert.strictEqual(size("1", 80), 80)
    assert.strictEqual(size("1001", 80), 80)
    assert.strictEqual(size("12x", 80), 80)
    assert.strictEqual(size(undefined, 24), 24)
    assert.deepStrictEqual(resize(5000, 40), { cols: 1000, rows: 40 })
    assert.isNull(resize(1, 40))
    assert.isNull(resize(80.5, 40))
    assert.isNull(resize(70000, 40))
  })
})
