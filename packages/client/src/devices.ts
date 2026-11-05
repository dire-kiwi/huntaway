import { enc, type Http } from "./http";

/** Devices paired with a board, such as the mobile app, each with a token of its own (API 116). */
export const DEVICES_API = 116;

/** A paired device (see server-ts/src/devices.ts). Its token is only ever given to it, when it pairs. */
export interface PairedDevice {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

/** A one-time pairing code, good for `ttl_secs` (five minutes) and one device. */
export interface PairingCode {
  code: string;
  expires_at: string;
  ttl_secs: number;
}

/** What a device gets for a pairing code: its token, and the board it's for. */
export interface Paired {
  token: string;
  device: PairedDevice;
  host_id: string;
  host_name: string;
  api_version: number;
}

/** The link a board's QR code holds: the board's address and a pairing code, never its token. */
export function pairingLink(url: string, code: string): string {
  return `huntaway://pair?url=${encodeURIComponent(url.replace(/\/+$/, ""))}&code=${encodeURIComponent(code)}`;
}

/** The board's address and the code in a pairing link (or null if it isn't one). */
export function parsePairingLink(link: string): { url: string; code: string } | null {
  const m = link.trim().match(/^huntaway:\/\/pair\/?\?(.*)$/i);
  if (!m) return null;
  const q = new Map<string, string>();
  for (const kv of m[1].split("&")) {
    const i = kv.indexOf("=");
    if (i < 0) continue;
    try {
      q.set(kv.slice(0, i), decodeURIComponent(kv.slice(i + 1).replace(/\+/g, " ")));
    } catch {
      return null;
    }
  }
  const url = q.get("url")?.trim().replace(/\/+$/, "");
  const code = q.get("code")?.trim();
  if (!url || !code || !/^https?:\/\/[^/\s]+/i.test(url)) return null;
  return { url, code };
}

export const devicesApi = ({ get, post, patch, del }: Http) => ({
  /** Needs no token: whether the board is up, and (API 116) its API version. */
  health: () => get<{ ok: boolean; commit: string | null; api_version?: number }>("/health"),
  /** The paired devices, and which one this is (`current`, when a device asks). */
  devices: () => get<{ devices: PairedDevice[]; current: string | null }>("/devices"),
  /** A new pairing code, for a QR code (not from a paired device). */
  pairingCode: () => post<PairingCode>("/devices/pairing"),
  /** Swaps a pairing code and this device's name for its token; needs no token. */
  pair: (code: string, name: string) => post<Paired>("/devices/pair", { code, name }),
  renameDevice: (id: string, name: string) => patch<PairedDevice>(`/devices/${enc(id)}`, { name }),
  /** Revokes a device: from the board, or a device unpairing itself. */
  revokeDevice: (id: string) => del<{ ok: boolean }>(`/devices/${enc(id)}`),
});
