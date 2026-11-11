import { Effect } from "effect"
import { AttachmentRpcs, NotFound } from "@huntaway/contracts"
import { Attachments } from "../tasks/Attachments.ts"

export const AttachmentHandlers = AttachmentRpcs.toLayer(
  Effect.gen(function* () {
    const attachments = yield* Attachments
    return AttachmentRpcs.of({
      "attachments.upload": ({ name, data }) => attachments.upload(name, data),
      "attachments.get": ({ id, name }) =>
        attachments
          .get(id, name)
          .pipe(Effect.catchTag("AttachmentNotFound", (e) => Effect.fail(new NotFound({ what: "attachment", id: `${e.id}/${e.file}` })))),
    })
  }),
)
