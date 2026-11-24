import { RpcSerialization } from "effect/rpc"

/**
 * The longest message, in string code units (bytes when they come as bytes), an RPC end takes. Effect's NDJSON parser
 * turns down a longer one with "Error decoding message", which ends every request on the connection; its default,
 * 16 MiB, is less than a board's snapshot can be (every task with its review and summaries: 16.8 MB on a board of 3,600
 * tasks), and a client that can't read the snapshot subscribes again, for ever, each time having the host make another.
 */
export const RPC_MAX_MESSAGE = 512 * 1024 * 1024

/**
 * The RPC serialization every client of the board's RPC uses: NDJSON that takes a message up to `RPC_MAX_MESSAGE`. A
 * server reads requests with a smaller limit (`RpcNdjsonServer` in the server's `http/websocket.ts`).
 */
export const RpcNdjson = RpcSerialization.layerNdjsonWith({ maxBufferSize: RPC_MAX_MESSAGE })
