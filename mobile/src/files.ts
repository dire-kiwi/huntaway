// Files on the phone that go to a board as attachments (shared from another app, or a voice note): read as base64,
// which is how the host's POST /attachments takes them. Its limit is 10 MB.
import { File } from "expo-file-system";

/** The largest file a host takes (server/src/attachments.rs's MAX_BYTES). */
export const MAX_ATTACHMENT_BYTES = 10 << 20;

/** A local file's contents, base64, or why it can't go. */
export async function readForUpload(uri: string, name: string): Promise<string> {
  const file = new File(uri);
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${name} is larger than 10 MB, which is as large as an attachment can be`);
  return file.base64();
}

export type ReadFile = typeof readForUpload;
