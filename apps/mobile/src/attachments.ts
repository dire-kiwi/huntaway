// Photos attached to a message are saved on the task's host (POST /attachments) and listed after its text
// (packages/client's withAttachments, as the web board does), so the agent reads them from there.
export { withAttachments } from "@huntaway/client";

/** A name for a photo the host takes (letters, digits, `.`, `_` and `-`). */
export function photoName(fileName: string | null | undefined, mime: string | null | undefined, now = Date.now()) {
  const ext = mime === "image/png" ? "png" : mime === "image/heic" ? "heic" : "jpg";
  const base = (fileName ?? "")
    .replace(/\.[^.]*$/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${base || `photo-${now}`}.${ext}`;
}
