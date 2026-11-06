// Photos attached to a message are saved on the task's host (POST /attachments) and listed after its text, as the
// web board does (app/src/attachments.ts), so the agent reads them from there.
import type { Attachment } from "@huntaway/client";

/** `text` with the attachments listed after it. */
export function withAttachments(text: string, files: Pick<Attachment, "path">[]): string {
  if (!files.length) return text;
  const list = `Attached files:\n${files.map((f) => `- ${f.path}`).join("\n")}`;
  return text.trim() ? `${text.trimEnd()}\n\n${list}` : list;
}

/** A name for a photo the host takes (letters, digits, `.`, `_` and `-`). */
export function photoName(fileName: string | null | undefined, mime: string | null | undefined, now = Date.now()) {
  const ext = mime === "image/png" ? "png" : mime === "image/heic" ? "heic" : "jpg";
  const base = (fileName ?? "").replace(/\.[^.]*$/, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${base || `photo-${now}`}.${ext}`;
}
