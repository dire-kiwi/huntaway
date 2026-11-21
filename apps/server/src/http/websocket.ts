/** The most one message to a socket the server accepts may hold, inflated: RPC's own limit (`RpcSerialization`). */
export const MAX_MESSAGE = 16 * 1024 * 1024

/**
 * The listeners' websocket options (`Main.ts`, `ReadOnlyMain.ts`): `ws`'s permessage-deflate for messages of 1 KiB or
 * more, for the RPC socket's JSON (docs/plan/09-frontend.md, The bundle). The relay's pipes turn it off for their own
 * sockets (`hosts/pipe.ts`): a frame queued for deflate isn't in the connection's buffer yet, which hides it from the
 * pipe's back-pressure.
 *
 * `maxPayload` bounds what a message inflates to: `/api/rpc` upgrades before any token, and `ws` would otherwise
 * inflate up to its default of 100 MiB from a few kilobytes on the wire before RPC rejected it. A message over it is
 * closed with 1009. RPC refuses more already, and terminal and viewer input are small; the desktop pane's DevTools
 * answers can be far bigger (a long page's accessibility tree is tens of MiB), so it sends those in parts
 * (`paneParts` in `@huntaway/shared`, joined by `browser/viewer.ts`'s `paneText`).
 */
export const websocketOptions = { perMessageDeflate: { threshold: 1024 }, maxPayload: MAX_MESSAGE } as const
