// Files attached on the board (the old src/attachments.ts, renamed so that it differs from Attachments.tsx by more than
// case): uploading one, and object URLs of those shown. How a message lists them is packages/client's.
import { Effect, Schema } from "effect"
import { Atom, AtomRegistry } from "effect/reactivity"
import { callRpc, MAX_ATTACHMENT_BYTES, mutate, type AttachmentRef } from "@huntaway/client"
import { AttachmentId } from "@huntaway/contracts"
import { nowMillis } from "../../state/clock"
import { isoOf } from "../ui/dates"

export const isImage = (name: string) => /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(name)

/** A file that can't be attached: too large, or the browser couldn't read it. */
class NotAttached extends Schema.TaggedError<NotAttached, { readonly brand: unique symbol }>()("NotAttached", { message: Schema.String }) {}

const readBase64 = (file: Blob): Effect.Effect<string, NotAttached> =>
  Effect.callback<string, NotAttached>((resume) => {
    const r = new FileReader()
    r.addEventListener("load", () => {
      const text = typeof r.result === "string" ? r.result : ""
      resume(Effect.succeed(text.slice(text.indexOf(",") + 1)))
    })
    r.addEventListener("error", () => resume(Effect.fail(new NotAttached({ message: r.error?.message ?? "couldn't read the file" }))))
    r.readAsDataURL(file)
    return Effect.sync(() => r.abort())
  })

/** A name for a pasted file, which usually comes as "image.png". */
function fileName(file: File) {
  if (file.name && file.name !== "image.png") return file.name
  const ext = file.type.split("/")[1]?.replace("jpeg", "jpg").replace(/\W.*/, "") || "bin"
  const stamp = isoOf(nowMillis()).slice(0, 19).replace(/[-:]/g, "").replace("T", "-")
  return `pasted-${stamp}.${ext}`
}

/** An attachment on a host, as its object URL is kept: compared by value. */
interface FileKey {
  readonly host: string
  readonly id: string
  readonly name: string
}

/** A file this page has just uploaded, so showing it needs no download (kept a minute for its thumbnail to take). */
const uploaded = Atom.family((key: FileKey) => Atom.make<Blob | null>(null).pipe(Atom.withLabel(`uploaded ${key.id}`), Atom.setIdleTTL("1 minute")))

/** Uploads `file` to `hostId` (`attachments.upload`), to attach to a prompt. */
export const uploadAttachment = Effect.fn("uploadAttachment")(function* (hostId: string, file: File) {
  const name = fileName(file)
  if (file.size > MAX_ATTACHMENT_BYTES) return yield* new NotAttached({ message: `${name} is larger than ${MAX_ATTACHMENT_BYTES >> 20} MB` })
  const att = yield* mutate("attachments.upload", hostId, { name, data: yield* readBase64(file) })
  const registry = yield* AtomRegistry.AtomRegistry
  registry.set(uploaded({ host: hostId, id: att.id, name: att.name }), file)
  return att
})

/**
 * An attachment's object URL, fetched once (`attachments.get`: an attachment never changes, so nothing reads it again)
 * and revoked a minute after the last thumbnail showing it has gone (the old cache kept the last 40).
 */
const urlAtom = Atom.family((key: FileKey) =>
  Atom.make(
    Effect.fnUntraced(function* (get) {
      const own = get(uploaded(key))
      const blob =
        own ??
        (yield* callRpc(key.host, "attachments.get", { id: AttachmentId.make(key.id), name: key.name }).pipe(
          Effect.map((a) => new Blob([Uint8Array.from(atob(a.data), (c) => c.charCodeAt(0))], { type: a.mime })),
        ))
      const url = URL.createObjectURL(blob)
      get.addFinalizer(() => URL.revokeObjectURL(url))
      return url
    }),
  ).pipe(Atom.setIdleTTL("1 minute")),
)

/** An object URL for an attachment on a host: read while something shows it. */
export const attachmentUrlAtom = (hostId: string, f: Pick<AttachmentRef, "id" | "name">) => urlAtom({ host: hostId, id: f.id, name: f.name })
