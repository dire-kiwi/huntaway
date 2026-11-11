import { Schema } from "effect"
import { AttachmentId } from "./ids.ts"

/** An uploaded file (the old `POST /attachments`), stored under the data folder's `attachments/<id>/<name>`. */
export const Attachment = Schema.Struct({
  id: AttachmentId,
  /** The cleaned file name it is stored under. */
  name: Schema.String,
  /** Its absolute path on the host, as agents are given it. */
  path: Schema.String,
  size: Schema.Int,
  mime: Schema.String,
})
export interface Attachment extends Schema.Schema.Type<typeof Attachment> {}

/** A file's contents, base64 (strict: padded, standard alphabet), as uploads and downloads carry them. */
export const AttachmentData = Schema.Struct({ name: Schema.String, size: Schema.Int, mime: Schema.String, data: Schema.String })
export interface AttachmentData extends Schema.Schema.Type<typeof AttachmentData> {}
