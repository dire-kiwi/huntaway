// Files attached on the board: uploading one, and object URLs of those shown. How a message lists them
// (withAttachments, splitAttachments) is packages/client's.
import { api, MAX_ATTACHMENT_BYTES, type Attachment, type AttachmentRef } from "./api";

export const isImage = (name: string) => /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(name);

function readBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve((r.result as string).slice((r.result as string).indexOf(",") + 1));
    r.onerror = () => reject(r.error ?? new Error("couldn't read the file"));
    r.readAsDataURL(file);
  });
}

/** A name for a pasted file, which usually comes as "image.png". */
function fileName(file: File) {
  if (file.name && file.name !== "image.png") return file.name;
  const ext = file.type.split("/")[1]?.replace("jpeg", "jpg").replace(/\W.*/, "") || "bin";
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  return `pasted-${stamp}.${ext}`;
}

export async function uploadAttachment(hostId: string, file: File): Promise<Attachment> {
  const name = fileName(file);
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${name} is larger than ${MAX_ATTACHMENT_BYTES >> 20} MB`);
  const att = await api.uploadAttachment(hostId, name, await readBase64(file));
  cache.set(key(hostId, att), { url: Promise.resolve(URL.createObjectURL(file)), users: 0 });
  trim();
  return att;
}

const key = (hostId: string, f: AttachmentRef) => `${hostId}/${f.id}/${f.name}`;

/** Object URLs of files on screen (`users`), and of the last few that were, least recent first. */
const cache = new Map<string, { url: Promise<string>; users: number }>();
const KEEP_UNUSED = 40;

function trim() {
  const unused = [...cache].filter(([, e]) => !e.users);
  for (const [k, e] of unused.slice(0, Math.max(0, unused.length - KEEP_UNUSED))) {
    cache.delete(k);
    e.url.then(URL.revokeObjectURL, () => {});
  }
}

/** An object URL for an attachment on a host, fetched once. Call `release` when it's off screen. */
export function attachmentUrl(hostId: string, f: AttachmentRef): { url: Promise<string>; release: () => void } {
  const k = key(hostId, f);
  let e = cache.get(k);
  if (!e) {
    const url = api.attachment(hostId, f.id, f.name).then((a) => {
      const bytes = Uint8Array.from(atob(a.data), (c) => c.charCodeAt(0));
      return URL.createObjectURL(new Blob([bytes], { type: a.mime }));
    });
    e = { url, users: 0 };
    const entry = e;
    url.catch(() => cache.get(k) === entry && cache.delete(k));
  }
  // Most recently used last.
  cache.delete(k);
  cache.set(k, e);
  e.users++;
  const entry = e;
  return {
    url: e.url,
    release: () => {
      entry.users--;
      if (cache.get(k) === entry) {
        cache.delete(k);
        cache.set(k, entry);
      }
      trim();
    },
  };
}
