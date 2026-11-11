import { Context } from "effect"
import type { RpcClientError, RpcClient, RpcGroup } from "effect/rpc"
import { HostRpcs, HubRpcs, PublicRpcs } from "@huntaway/contracts"

/** Every RPC a client of a host can call: the host's own groups and the public ones (the hub's join them in M7). */
export const ClientRpcs = PublicRpcs.merge(HostRpcs, HubRpcs)
export type ClientRpcs = RpcGroup.Rpcs<typeof ClientRpcs>

/** A host's RPC client, reached directly (the page's own board) or, from M7, through the hub's relay. */
export class HostClient extends Context.Service<HostClient, RpcClient.RpcClient.Flat<ClientRpcs, RpcClientError.RpcClientError>>()(
  "@huntaway/client/session/HostClient",
) {}
