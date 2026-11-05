// Sharing into the assistant: a link, text, photo or file shared from another app (Android's share sheet, or the iOS
// share extension, both from expo-share-intent) opens the Assistant tab with its composer filled in. With several boards
// that can take it, the app asks which (the last one picked comes first). Nothing shared is ever taken as an address or
// a token: it only ever becomes a draft message and its attachments.
import { useSyncExternalStore } from "react";
import { showsAssistant } from "./assistant";
import type { Board } from "./boards";

/** What expo-share-intent gives (its `ShareIntent`), as far as the app reads it. */
export interface SharedIntent {
  text?: string | null;
  webUrl?: string | null;
  meta?: { title?: string | null } | null;
  files?: { path: string | null; fileName?: string | null; mimeType?: string | null; size?: number | null }[] | null;
}

/** A file shared into the app, still on the phone: it's uploaded to the assistant's host when the composer takes it. */
export interface SharedFile {
  uri: string;
  /** A name the host takes (letters, digits, `.`, `_` and `-`). */
  name: string;
  mime: string;
  size: number | null;
}

export interface SharedDraft {
  text: string;
  files: SharedFile[];
}

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
};

/** A name for a shared file that the host takes: its own name cleaned up, with an extension from its type if it had none. */
export function sharedFileName(fileName: string | null | undefined, mime: string | null | undefined, n: number, now = Date.now()) {
  const raw = (fileName ?? "").split(/[/\\]/).pop() ?? "";
  const dot = raw.lastIndexOf(".");
  const ext = dot > 0 ? raw.slice(dot + 1).replace(/[^A-Za-z0-9]/g, "").slice(0, 10) : "";
  const base = (dot > 0 ? raw.slice(0, dot) : raw).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "").slice(0, 80);
  const kind = mime?.split("/")[0];
  const fallback = `${kind === "image" ? "photo" : kind === "audio" ? "audio" : "shared"}-${now}${n ? `-${n}` : ""}`;
  return `${base || fallback}.${ext || EXT[mime ?? ""] || "bin"}`;
}

/**
 * The draft a share makes: its text (with the link, if the text doesn't already hold it, and the page's title before a
 * link shared on its own) and its files. None when there's nothing in it.
 */
export function sharedDraft(intent: SharedIntent | null | undefined, now = Date.now()): SharedDraft | null {
  if (!intent) return null;
  const text = (intent.text ?? "").trim();
  const url = (intent.webUrl ?? "").trim();
  const title = (intent.meta?.title ?? "").trim();
  let out = text;
  if (url && !text.includes(url)) out = text ? `${text}\n${url}` : url;
  // A link on its own (as browsers share one) reads better with what it is.
  if (title && url && out === url && title !== url) out = `${title}\n${url}`;
  const files = (intent.files ?? [])
    .filter((f): f is NonNullable<typeof f> & { path: string } => !!f?.path)
    .map((f, i) => ({ uri: f.path, name: sharedFileName(f.fileName, f.mimeType, i, now), mime: f.mimeType || "application/octet-stream", size: f.size ?? null }));
  return out || files.length ? { text: out, files } : null;
}

/** The field's text with `added` put after what was already typed there, on a line of its own. */
export function withDraft(current: string, added: string): string {
  if (!added.trim()) return current;
  return current.trim() ? `${current.trimEnd()}\n\n${added}` : added;
}

// ---------- which board ----------

/**
 * Which boards a share can go to (paired, usable and with the assistant), and the one to use without asking: the only
 * one, if there's just one. Otherwise the last one picked comes first.
 */
export function shareTargets(list: Board[], status: (id: string) => { unauthorized: boolean; tooOld: boolean }, last: string | null): { only?: Board; boards: Board[] } {
  const boards = list.filter((b) => showsAssistant(b, status(b.id)));
  const sorted = [...boards.filter((b) => b.id === last), ...boards.filter((b) => b.id !== last)];
  return { only: sorted.length === 1 ? sorted[0] : undefined, boards: sorted };
}

// ---------- the share waiting to be taken ----------

export interface PendingShare {
  id: number;
  draft: SharedDraft;
  /** The board whose assistant takes it, once picked. */
  boardId: string | null;
}

/** The share waiting for the Assistant tab's composer to take it (one at a time: a newer share replaces it). */
export class PendingShares {
  private current: PendingShare | null = null;
  private n = 0;
  private listeners = new Set<() => void>();

  get = () => this.current;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  put(draft: SharedDraft, boardId: string | null = null): PendingShare {
    this.set({ id: ++this.n, draft, boardId });
    return this.current!;
  }

  /** Sends the waiting share to a board's assistant. */
  target(boardId: string) {
    if (this.current) this.set({ ...this.current, boardId });
  }

  /** Done with share `id` (taken, or dropped): a newer one stays. */
  clear(id: number) {
    if (this.current?.id === id) this.set(null);
  }

  private set(next: PendingShare | null) {
    this.current = next;
    for (const fn of this.listeners) fn();
  }
}

export const shares = new PendingShares();

export const usePendingShare = () => useSyncExternalStore(shares.subscribe, shares.get);
