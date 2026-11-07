/**
 * The page an address typed into the browser pane goes to, or null for one it can't open: web pages only. A bare port
 * is on localhost, and a host without a scheme gets http: when it's this machine (or another on the LAN, by its IP) and
 * https: otherwise, as a browser's address bar does.
 */
export function browserUrl(input: string): string | null {
  const s = input.trim();
  if (!s || /\s/.test(s)) return null;
  let full = s;
  if (/^\d{1,5}$/.test(s)) full = `http://localhost:${s}/`;
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    // Not a scheme: "localhost:5173" and "example.com:8080/x" are a host and port.
    if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s)) return null;
    const local = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|[^/:]+\.local(:|\/|$))/i.test(s);
    full = `${local ? "http" : "https"}://${s}`;
  }
  try {
    const url = new URL(full);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}
