import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Attachment, AttachmentData } from "../attachment.ts"
import { Invalid, NotFound } from "../errors.ts"
import { AttachmentId } from "../ids.ts"
import { Auth, RequiredScope } from "../session.ts"

/** Uploaded files: at most 10 MiB each, sent as base64. */
export class AttachmentRpcs extends RpcGroup.make(
  Rpc.make("attachments.upload", { payload: { name: Schema.String, data: Schema.String }, success: Attachment, error: Invalid }).annotate(
    RequiredScope,
    "operate",
  ),
  Rpc.make("attachments.get", { payload: { id: AttachmentId, name: Schema.String }, success: AttachmentData, error: NotFound }).annotate(RequiredScope, "read"),
).middleware(Auth) {}
