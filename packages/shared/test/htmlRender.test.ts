import { describe, expect, it } from "vite-plus/test"
import { htmlRenderAttachment, htmlRenderFileName, htmlRenderStyle, inlineImages, isImageBytes, localImages, viewportHeightUnit } from "../src/htmlRender.ts"

describe("viewportHeightUnit", () => {
  it("finds a viewport height unit in a stylesheet or a style attribute", () => {
    expect(viewportHeightUnit("<style>main{min-height:100vh}</style>")).toBe("100vh")
    expect(viewportHeightUnit('<div style="height: 50dvh">x</div>')).toBe("50dvh")
    expect(viewportHeightUnit("<div style=height:.5svh>x</div>")).toBe(".5svh")
  })

  it("passes text, comments, widths and base64 that only look like one", () => {
    expect(viewportHeightUnit("<p>Use 100vh for full height</p>")).toBeNull()
    expect(viewportHeightUnit("<style>/* ok */ .a{width:100vw}</style><!-- <style>a{height:1vh}</style> -->")).toBeNull()
    expect(viewportHeightUnit("<style>.a{background:url(data:image/png;base64,AAA+1vhB)}</style>")).toBeNull()
  })
})

describe("localImages", () => {
  it("finds absolute paths to images in quotes and CSS url(), and puts data URIs in their place", () => {
    const html = `<img src="/tmp/a.png"><div style="background:url(/x/b.webp)"></div><script>const s = '/tmp/a.png'</script><img src="//cdn/x.png"><img src="rel.png">`
    const found = localImages(html)
    expect(found.map((f) => f.path)).toEqual(["/tmp/a.png", "/x/b.webp", "/tmp/a.png"])
    const out = inlineImages(html, found, new Map([["/tmp/a.png", "data:image/png;base64,AA=="]]))
    expect(out).toBe(
      `<img src="data:image/png;base64,AA=="><div style="background:url(/x/b.webp)"></div><script>const s = 'data:image/png;base64,AA=='</script><img src="//cdn/x.png"><img src="rel.png">`,
    )
  })
})

describe("isImageBytes", () => {
  const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0))
  it("knows images by their bytes, not their names", () => {
    expect(isImageBytes(bytes("\x89PNG\r\n\x1a\n...."))).toBe(true)
    expect(isImageBytes(bytes("\xff\xd8\xff\xe0...."))).toBe(true)
    expect(isImageBytes(bytes("RIFF....WEBPVP8 "))).toBe(true)
    expect(isImageBytes(bytes('<?xml version="1.0"?>\n<!-- a -->\n<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(true)
    expect(isImageBytes(bytes("-----BEGIN OPENSSH PRIVATE KEY-----"))).toBe(false)
    expect(isImageBytes(bytes("<html><svg></svg></html>"))).toBe(false)
  })
})

describe("the kept page", () => {
  it("is named from its title, and found again from html_render's answer", () => {
    expect(htmlRenderFileName("Test results: May / June")).toBe("Test-results-May-June.html")
    expect(htmlRenderFileName("…")).toBe("page.html")
    const id = "0123456789abcdef0123456789abcdef"
    expect(htmlRenderAttachment(`The user sees the page.\n(Kept as /data/attachments/${id}/Chart.html.)`)).toEqual({ id, name: "Chart.html" })
    expect(htmlRenderAttachment("These local images couldn't be read")).toBeNull()
  })

  it("starts with the theme's variables, and drops what could end the rule", () => {
    const css = htmlRenderStyle({ "--bg": "#000", "--fg": "red;}</style><script>", "bad name": "x" })
    expect(css).toContain(":root{color-scheme:dark;--bg:#000;--fg:red/stylescript;}")
    expect(css).not.toContain("bad name")
  })
})
