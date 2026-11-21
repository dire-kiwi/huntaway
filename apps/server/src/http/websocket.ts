/**
 * The listeners' websocket options (`Main.ts`, `ReadOnlyMain.ts`): `ws`'s permessage-deflate for messages of 1 KiB or
 * more, for the RPC socket's JSON (docs/plan/09-frontend.md, The bundle). The relay's pipes turn it off for their own
 * sockets (`hosts/pipe.ts`): a frame queued for deflate isn't in the connection's buffer yet, which hides it from the
 * pipe's back-pressure.
 */
export const websocketOptions = { perMessageDeflate: { threshold: 1024 } } as const
