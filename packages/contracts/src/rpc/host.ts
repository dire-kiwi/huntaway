import { Rpc, RpcGroup } from "effect/rpc"
import { HostInfo } from "../host.ts"
import { Auth, RequiredScope } from "../session.ts"

/** This host about itself. Settings, usage and the folder browser join it in later milestones. */
export class HostRpcGroup extends RpcGroup.make(Rpc.make("host.info", { success: HostInfo }).annotate(RequiredScope, "read")).middleware(Auth) {}
