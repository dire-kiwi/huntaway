import { describe, expect, it } from "@effect/vitest"
import { insecure, parseBoardLink, rpcUrl } from "../src/logic/link"

describe("parseBoardLink", () => {
  it("takes the board's network link, with its token", () => {
    expect(parseBoardLink("http://my-box:7878/?token=abc%2Fdef")).toEqual({ url: "http://my-box:7878", token: "abc/def" })
  })

  it("takes a bare address as http, with no token", () => {
    expect(parseBoardLink("  192.168.1.5:7878 ")).toEqual({ url: "http://192.168.1.5:7878", token: "" })
    expect(parseBoardLink("https://Board.example.ts.net/")).toEqual({ url: "https://board.example.ts.net", token: "" })
  })

  it("keeps an IPv6 host and drops the path and fragment", () => {
    expect(parseBoardLink("http://[::1]:7879/board#x")).toEqual({ url: "http://[::1]:7879", token: "" })
  })

  it("turns down what isn't a board's address", () => {
    expect(parseBoardLink("")).toEqual({ error: "Give the board's address." })
    expect(parseBoardLink("ftp://box")).toEqual({ error: "A board's address starts with http:// or https://." })
    expect(parseBoardLink("http://")).toEqual({ error: "That address has no host." })
    expect(parseBoardLink("http://box:99999")).toEqual({ error: "That isn't an address." })
    expect(parseBoardLink("two words")).toEqual({ error: "That isn't an address." })
  })
})

describe("rpcUrl and insecure", () => {
  it("is the board's websocket RPC", () => {
    expect(rpcUrl("http://box:7878")).toBe("ws://box:7878/api/rpc")
    expect(rpcUrl("https://box")).toBe("wss://box/api/rpc")
  })

  it("is insecure only for plain HTTP to another machine", () => {
    expect(insecure("http://box:7878")).toBe(true)
    expect(insecure("https://box")).toBe(false)
    expect(insecure("http://127.0.0.1:7878")).toBe(false)
    expect(insecure("http://10.0.2.2:7878")).toBe(false)
  })
})
