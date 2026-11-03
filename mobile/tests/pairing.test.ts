import { pairingLink, parsePairingLink } from "@huntaway/client";
import { isPlainHttp, MIN_API, pair, PairingError } from "../src/pairing";
import { fakeFetch } from "./helpers";

const paired = {
  token: "device-token",
  device: { id: "dev-1", name: "Pixel", created_at: "2026-11-03T00:00:00.000Z", last_used_at: null },
  host_id: "host-1",
  host_name: "work-hub",
  api_version: MIN_API,
};

function board(opts: { api?: number; code?: string } = {}) {
  return fakeFetch((method, path, body) => {
    if (method === "GET" && path === "/api/health") return { status: 200, body: { ok: true, commit: null, api_version: opts.api ?? MIN_API } };
    if (method === "POST" && path === "/api/devices/pair")
      return (body as { code: string }).code === (opts.code ?? "abc") ? { status: 200, body: paired } : { status: 403, body: { error: "expired" } };
  });
}

const link = pairingLink("https://work.tailnet.ts.net/", "abc");

describe("pairing links", () => {
  test("round-trip the board's address and the code, never a token", () => {
    expect(link).toBe("huntaway://pair?url=https%3A%2F%2Fwork.tailnet.ts.net&code=abc");
    expect(parsePairingLink(link)).toEqual({ url: "https://work.tailnet.ts.net", code: "abc" });
    expect(parsePairingLink("  " + link + "\n")).toEqual({ url: "https://work.tailnet.ts.net", code: "abc" });
  });

  test("other links aren't pairing links", () => {
    for (const bad of ["", "https://work.tailnet.ts.net/?token=x", "huntaway://pair?url=ftp%3A%2F%2Fx&code=a", "huntaway://pair?url=https%3A%2F%2Fx", "huntaway://other?url=x&code=y"]) {
      expect(parsePairingLink(bad)).toBeNull();
    }
  });

  test("plain HTTP is refused unless it's this device", () => {
    expect(isPlainHttp("http://work:7878")).toBe(true);
    expect(isPlainHttp("https://work")).toBe(false);
    expect(isPlainHttp("http://localhost:7878")).toBe(false);
    expect(isPlainHttp("http://10.0.2.2:7878")).toBe(false);
  });
});

describe("pair", () => {
  test("swaps the code and the phone's name for a token, after checking the board's version", async () => {
    const { fetch, calls } = board();
    const { board: b, token } = await pair(link, "Pixel", { fetch });
    expect(token).toBe("device-token");
    expect(b).toEqual({ id: "host-1", url: "https://work.tailnet.ts.net", name: "work-hub", deviceId: "dev-1", apiVersion: MIN_API, profile: null, pairedAt: paired.device.created_at });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET https://work.tailnet.ts.net/api/health", "POST https://work.tailnet.ts.net/api/devices/pair"]);
    expect(calls[1].body).toEqual({ code: "abc", name: "Pixel" });
  });

  test("an older board is too old, before the code is used", async () => {
    const { fetch, calls } = board({ api: MIN_API - 1 });
    await expect(pair(link, "Pixel", { fetch })).rejects.toMatchObject({ problem: "too_old" });
    expect(calls).toHaveLength(1);
    // One from before /health said its version.
    const old = fakeFetch((_m, p) => (p === "/api/health" ? { status: 200, body: { ok: true, commit: null } } : undefined));
    await expect(pair(link, "Pixel", { fetch: old.fetch })).rejects.toMatchObject({ problem: "too_old" });
  });

  test("an expired or used code says so", async () => {
    const { fetch } = board({ code: "other" });
    const err = await pair(link, "Pixel", { fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(PairingError);
    expect(err.problem).toBe("code");
  });

  test("an unreachable board, a bad link and plain HTTP", async () => {
    const down = async () => {
      throw new TypeError("Network request failed");
    };
    await expect(pair(link, "Pixel", { fetch: down })).rejects.toMatchObject({ problem: "unreachable" });
    await expect(pair("https://example.com", "Pixel", { fetch: down })).rejects.toMatchObject({ problem: "link" });
    await expect(pair(pairingLink("http://work:7878", "abc"), "Pixel", { fetch: down })).rejects.toMatchObject({ problem: "insecure" });
    const { fetch } = board();
    await expect(pair(pairingLink("http://work:7878", "abc"), "Pixel", { fetch, allowHttp: true })).resolves.toMatchObject({ token: "device-token" });
  });
});
