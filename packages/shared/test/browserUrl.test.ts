import { describe, expect, it } from "vite-plus/test"
import { browserUrl } from "../src/browserUrl.ts"

describe("browserUrl", () => {
  it("reads a port as localhost's, and a host without a scheme as a browser's address bar does", () => {
    expect(browserUrl("5173")).toBe("http://localhost:5173/")
    expect(browserUrl(":3000")).toBe("http://localhost:3000/")
    expect(browserUrl("localhost:8080/x")).toBe("http://localhost:8080/x")
    expect(browserUrl("192.168.1.4:9000")).toBe("http://192.168.1.4:9000/")
    expect(browserUrl("example.com")).toBe("https://example.com/")
    expect(browserUrl("http://example.com/a?b=1")).toBe("http://example.com/a?b=1")
  })

  it("opens web pages only", () => {
    expect(browserUrl("")).toBeNull()
    expect(browserUrl("two words")).toBeNull()
    expect(browserUrl("file:///etc/passwd")).toBeNull()
    expect(browserUrl("javascript:alert(1)")).toBeNull()
    expect(browserUrl("mailto:a@b.c")).toBeNull()
  })
})
