// Files attached on the board (the old src/attachments.ts, renamed so that it differs from Attachments.tsx by more than
// case): uploading one, and object URLs of those shown. How a message lists them is packages/client's.
import { MAX_ATTACHMENT_BYTES, type AttachmentRef } from "@huntaway/client"
import { type Attachment, AttachmentId } from "@huntaway/contracts"
import { rpc } from "../../state/rpc"

export const isImage = (name: string) => /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(name)

function readBase64(file: Blob): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  const r = new FileReader()
  r.addEventListener("load", () => {
    const text = typeof r.result === "string" ? r.result : ""
    resolve(text.slice(text.indexOf(",") + 1))
  })
  r.addEventListener("error", () => reject(r.error ?? new Error("couldn't read the file")))
  r.readAsDataURL(file)
  return promise
}

/** A name for a pasted file, which usually comes as "image.png". */
function fileName(file: File) {
  if (file.name && file.name !== "image.png") return file.name
  const ext = file.type.split("/")[1]?.replace("jpeg", "jpg").replace(/\W.*/, "") || "bin"
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-")
  return `pasted-${stamp}.${ext}`
}

export async function uploadAttachment(hostId: string, file: File): Promise<Attachment> {
  const name = fileName(file)
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${name} is larger than ${MAX_ATTACHMENT_BYTES >> 20} MB`)
  const att = await rpc(hostId, "attachments.upload", { name, data: await readBase64(file) })
  cache.set(key(hostId, att), { url: Promise.resolve(URL.createObjectURL(file)), users: 0 })
  trim()
  return att
}

const key = (hostId: string, f: AttachmentRef) => `${hostId}/${f.id}/${f.name}`

/** Object URLs of files on screen (`users`), and of the last few that were, least recent first. */
const cache = new Map<string, { url: Promise<string>; users: number }>()
const KEEP_UNUSED = 40

function trim() {
  const unused = [...cache].filter(([, e]) => !e.users)
  for (const [k, e] of unused.slice(0, Math.max(0, unused.length - KEEP_UNUSED))) {
    cache.delete(k)
    e.url.then(
      (u) => URL.revokeObjectURL(u),
      () => {},
    )
  }
}

/** An object URL for an attachment on a host, fetched once. Call `release` when it's off screen. */
export function attachmentUrl(hostId: string, f: AttachmentRef): { url: Promise<string>; release: () => void } {
  const k = key(hostId, f)
  let e = cache.get(k)
  if (!e) {
    const url = rpc(hostId, "attachments.get", { id: AttachmentId.make(f.id), name: f.name }).then((a) => {
      const bytes = Uint8Array.from(atob(a.data), (c) => c.charCodeAt(0))
      return URL.createObjectURL(new Blob([bytes], { type: a.mime }))
    })
    e = { url, users: 0 }
    const entry = e
    url.catch(() => cache.get(k) === entry && cache.delete(k))
  }
  // Most recently used last.
  cache.delete(k)
  cache.set(k, e)
  e.users++
  const entry = e
  return {
    url: e.url,
    release: () => {
      entry.users--
      if (cache.get(k) === entry) {
        cache.delete(k)
        cache.set(k, entry)
      }
      trim()
    },
  }
}
