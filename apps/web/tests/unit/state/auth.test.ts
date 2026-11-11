import { describe, expect, it } from "@effect/vitest"
import { rpcUrl } from "../../../src/state/auth"

describe("the server's address", () => {
  it("is the page's own host's /api/rpc, over wss for an https page", () => {
    expect(rpcUrl({ protocol: "http:", host: "127.0.0.1:5173" })).toBe("ws://127.0.0.1:5173/api/rpc")
    expect(rpcUrl({ protocol: "https:", host: "board.example.com" })).toBe("wss://board.example.com/api/rpc")
  })
})
