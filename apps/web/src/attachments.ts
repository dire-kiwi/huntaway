import { api, type Attachment } from "./api";

/**
 * Files attached to a prompt are saved on the host (server: attachments.rs) and listed at the
 * end of the message, so the agent reads them from there:
 *
 *     Attached files:
 *     - /home/me/.local/share/huntaway/attachments/<id>/<name>
 *
 * The UI splits that block back off to show the files instead.
 */
const HEADER = "Attached files:";

/** Largest file a host takes (server: attachments::MAX_BYTES). */
export const MAX_ATTACHMENT_BYTES = 10 << 20;

/** A file listed in a message: enough to fetch it again. */
export type AttachmentRef = Pick<Attachment, "id" | "name" | "path">;

/** `text` with the attachments listed after it. */
export function withAttachments(text: string, files: AttachmentRef[]): string {
  if (!files.length) return text;
  const list = `${HEADER}\n${files.map((f) => `- ${f.path}`).join("\n")}`;
  return text.trim() ? `${text.trimEnd()}\n\n${list}` : list;
}

const LINE = /^- (.*\/attachments\/([0-9a-f]+)\/([A-Za-z0-9._-]+))$/;

/**
 * Split the attachment lists off a message. Queued messages are joined, so there may be one
 * per message that went into it.
 */
export function splitAttachments(text: string): { text: string; files: AttachmentRef[] } {
  const lines = text.trimEnd().split("\n");
  const files: AttachmentRef[] = [];
  const rest: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const block: AttachmentRef[] = [];
    let m: RegExpExecArray | null;
    if (lines[i] === HEADER) {
      while (i + 1 + block.length < lines.length && (m = LINE.exec(lines[i + 1 + block.length]))) block.push({ path: m[1], id: m[2], name: m[3] });
    }
    if (!block.length) {
      rest.push(lines[i]);
      continue;
    }
    files.push(...block);
    i += block.length;
    // The blank line between it and the next message.
    if (lines[i + 1] === "") i++;
  }
  return files.length ? { text: rest.join("\n").trimEnd(), files } : { text, files };
}

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
