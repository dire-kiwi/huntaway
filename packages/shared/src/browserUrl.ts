// Every runtime this package runs in has the WHATWG URL; its types come with neither DOM's nor Node's, which it has none of.
declare const URL: {
  canParse(url: string): boolean
  new (url: string): { readonly href: string; readonly protocol: string }
}

/**
 * The page an address typed into a task's browser goes to (HE-62, after the old pane's HA-275), or null for one it
 * can't open: web pages only. A bare port is on localhost, and a host without a scheme gets http: when it's this
 * machine (or another on the LAN, by its IP) and https: otherwise, as a browser's address bar does. The board's pane
 * and the agent's `navigate` read addresses the same way.
 */
export function browserUrl(input: string): string | null {
  const s = input.trim()
  if (!s || /\s/.test(s)) return null
  let full = s
  // A port, and maybe a path: "5173", ":3000", "8080/api/health".
  if (/^:?\d{1,5}(\/|$)/.test(s)) full = `http://localhost:${s.replace(/^:/, "")}${s.includes("/") ? "" : "/"}`
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    // Not a scheme: "localhost:5173" and "example.com:8080/x" are a host and port.
    if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s)) return null
    const local = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|[^/:]+\.local(:|\/|$))/i.test(s)
    full = `${local ? "http" : "https"}://${s}`
  }
  if (!URL.canParse(full)) return null
  const url = new URL(full)
  return url.protocol === "http:" || url.protocol === "https:" ? url.href : null
}
