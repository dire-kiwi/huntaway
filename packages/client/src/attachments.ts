import type { Attachment } from "./tasks";

/**
 * Files attached to a prompt are saved on the host (server-ts/src/attachments.ts) and listed at the end of the message, so
 * the agent reads them from there:
 *
 *     Attached files:
 *     - /home/me/.local/share/huntaway/attachments/<id>/<name>
 *
 * The board and the phone split that block back off to show the files instead.
 */
const HEADER = "Attached files:";

/** Largest file a host takes (server-ts/src/attachments.ts's MAX_BYTES). */
export const MAX_ATTACHMENT_BYTES = 10 << 20;

/** A file listed in a message: enough to fetch it again. */
export type AttachmentRef = Pick<Attachment, "id" | "name" | "path">;

/** `text` with the attachments listed after it. */
export function withAttachments(text: string, files: Pick<Attachment, "path">[]): string {
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
