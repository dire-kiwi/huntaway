// Pairing with a board: the link from its QR code (huntaway://pair?url=…&code=…) holds the board's address and a
// one-time code, which POST /devices/pair swaps for this phone's own token. The board's API version is checked first,
// so an older board says it's too old rather than failing somewhere later.
import { ApiError, createClient, parsePairingLink, type Fetch } from "@huntaway/client";
import type { Board } from "./boards";

/** The oldest board API the app works with: device tokens and pairing came in API 118. */
export const MIN_API = 118;

export type PairingProblem = "link" | "insecure" | "unreachable" | "too_old" | "code" | "other";

export class PairingError extends Error {
  constructor(
    public problem: PairingProblem,
    message: string,
  ) {
    super(message);
  }
}

/** Whether a board's address is plain HTTP somewhere other than this device, which phones refuse. */
export const isPlainHttp = (url: string) => /^http:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2)(:|\/|$)/i.test(url);

/** Whether a board with this API version is new enough for the app. */
export const tooOld = (apiVersion: number | undefined) => !apiVersion || apiVersion < MIN_API;

export const tooOldMessage = (name: string, apiVersion: number | undefined) =>
  `${name} runs an older Huntaway (API ${apiVersion || "before 118"}) than this app needs (API ${MIN_API} or later). Update the board, then pair again.`;

/**
 * Pairs with the board in `link` as `deviceName`. `allowHttp` lets a development build reach a board on plain HTTP
 * (an emulator's 10.0.2.2, say); release builds can't anyway.
 */
export async function pair(link: string, deviceName: string, opts: { fetch?: Fetch; allowHttp?: boolean } = {}): Promise<{ board: Board; token: string }> {
  const parsed = parsePairingLink(link);
  if (!parsed) throw new PairingError("link", "That isn't a Huntaway pairing link. It starts with huntaway://pair, from Settings → Network access → Pair a phone.");
  const { url, code } = parsed;
  if (isPlainHttp(url) && !opts.allowHttp) {
    throw new PairingError("insecure", `${url} is plain HTTP, which phones refuse. Serve the board over HTTPS (tailscale serve --bg 7878) and pair from that address.`);
  }
  let token = "";
  const client = createClient({ baseUrl: url, getToken: () => token, setToken: (t) => (token = t), storage: memoryStorage(), fetch: opts.fetch });
  let health: { api_version?: number };
  try {
    health = await client.health();
  } catch (e) {
    if (e instanceof ApiError) throw new PairingError("unreachable", `${url} answered, but not as a Huntaway board (${e.status}).`);
    throw new PairingError("unreachable", `Couldn't reach ${url}. Check that this phone can open it (on the same tailnet or VPN) and that it's HTTPS.`);
  }
  if (tooOld(health.api_version)) throw new PairingError("too_old", tooOldMessage(url, health.api_version));
  try {
    const paired = await client.pair(code, deviceName);
    token = paired.token;
    const board: Board = {
      id: paired.host_id,
      url,
      name: paired.host_name || url.replace(/^https?:\/\//, ""),
      deviceId: paired.device.id,
      apiVersion: paired.api_version,
      profile: null,
      pairedAt: paired.device.created_at,
    };
    return { board, token };
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) throw new PairingError("code", "That code has expired or was already used. Show a new one on the board and scan it again.");
    if (e instanceof ApiError && e.status === 404) throw new PairingError("too_old", tooOldMessage(url, health.api_version));
    throw new PairingError("other", e instanceof Error ? e.message : String(e));
  }
}

/**
 * After pairing a board again, unpairs this phone's previous device there, so the board doesn't keep a token the app
 * has thrown away. A device may only unpair itself, so it's done with the old token, if that still works (it may have
 * been revoked already). Resolves to whether it was unpaired.
 */
export async function unpairPrevious(
  url: string,
  previous: { deviceId: string; token: string } | null,
  current: { deviceId: string },
  opts: { fetch?: Fetch } = {},
): Promise<boolean> {
  if (!previous?.deviceId || !previous.token || previous.deviceId === current.deviceId) return false;
  const client = createClient({ baseUrl: url, getToken: () => previous.token, setToken: () => {}, storage: memoryStorage(), fetch: opts.fetch });
  try {
    await client.revokeDevice(previous.deviceId);
    return true;
  } catch {
    return false;
  }
}

/** Storage for what a client remembers of a board besides its token, which the app doesn't need to keep. */
export function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}
