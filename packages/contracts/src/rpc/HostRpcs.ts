import { HostRpcGroup } from "./host.ts"

/** Every group a host serves about itself (docs/plan/05-protocol.md, The contract package). */
export const HostRpcs = HostRpcGroup
export type HostRpcs = typeof HostRpcs
