import { Pencil, QrCode, Smartphone, X } from "lucide-react";
import qrcode from "qrcode-generator";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, pairingLink, type PairedDevice, type PairingCode } from "../../api";
import { useStore } from "../../store";
import { copyText } from "../ui/links";
import { Button, IconButton, Input, timeAgo, useConfirm } from "../ui";

/** Where the phone reaches the board: the host's public address if it has one, else this page's, if it's HTTPS. */
function defaultAddress(publicUrl: string | null | undefined) {
  if (publicUrl?.trim()) return publicUrl.trim().replace(/\/+$/, "");
  return window.location.protocol === "https:" ? window.location.origin : "";
}

/** A QR code of `text`, as an SVG of its modules. */
function QrSvg({ text, size = 200 }: { text: string; size?: number }) {
  const path = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4},${r + 4}h1v1h-1z`;
    return { d, n: n + 8 };
  }, [text]);
  return (
    <svg role="img" aria-label="Pairing QR code" width={size} height={size} viewBox={`0 0 ${path.n} ${path.n}`} shapeRendering="crispEdges" className="rounded-lg">
      <rect width={path.n} height={path.n} fill="#fff" />
      <path d={path.d} fill="#000" />
    </svg>
  );
}

/**
 * Settings → Network access → Phones: pair the mobile app by its QR code (a one-time code that lasts five minutes,
 * never the board's token), and rename or revoke the devices paired with this board (API 118).
 */
export function DevicesPanel() {
  const localHostId = useStore((s) => s.localHostId);
  const settings = useStore((s) => (s.localHostId ? s.hostSettings[s.localHostId] : undefined));
  const loadHostSettings = useStore((s) => s.loadHostSettings);
  const publicUrl = settings?.public_url;
  const [devices, setDevices] = useState<PairedDevice[] | null>(null);
  const [pairing, setPairing] = useState<PairingCode | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [err, setErr] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const { ask, dialog } = useConfirm();

  const load = useCallback(() => {
    api
      .devices()
      .then((r) => setDevices(r.devices))
      .catch((e) => setErr((e as Error).message));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    if (localHostId && !settings) void loadHostSettings(localHostId);
  }, [localHostId, settings, loadHostSettings]);

  const expiresAt = pairing ? new Date(pairing.expires_at).getTime() : 0;
  const left = Math.max(0, Math.round((expiresAt - now) / 1000));
  // While a code is shown: tick its countdown, and look for the phone that pairs with it.
  useEffect(() => {
    if (!pairing) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(load, 3000);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [pairing, load]);
  // A device paired: the code is used up.
  const [countAtStart, setCountAtStart] = useState(0);
  useEffect(() => {
    if (pairing && devices && devices.length > countAtStart) setPairing(null);
  }, [devices, pairing, countAtStart]);

  const start = async () => {
    setErr(null);
    try {
      const code = await api.pairingCode();
      setCountAtStart(devices?.length ?? 0);
      setNow(Date.now());
      setPairing(code);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const board = (address ?? defaultAddress(publicUrl)).trim().replace(/\/+$/, "");
  const validAddress = /^https?:\/\/[^/\s]+/i.test(board);
  const plainHttp = /^http:\/\//i.test(board) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/i.test(board);
  const link = pairing && validAddress ? pairingLink(board, pairing.code) : "";

  const rename = async () => {
    if (!renaming) return;
    try {
      await api.renameDevice(renaming.id, renaming.name);
      setRenaming(null);
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-line px-3 py-3" aria-label="Phones">
      <div className="flex items-center gap-2 text-[12.5px] font-medium text-fg">
        <Smartphone size={14} /> Phones
      </div>
      <p>
        Pair the Huntaway app on a phone by scanning a QR code. It holds this board's address and a code that works once, for five minutes, and the
        phone gets a token of its own, which you can revoke here at any time. The phone reaches the board over HTTPS, such as with{" "}
        <code>tailscale serve</code> (see <i>The mobile app</i> in docs/guide/mobile.md).
      </p>
      {!pairing ? (
        <Button size="sm" variant="primary" onClick={start}>
          <QrCode size={13} /> Pair a phone
        </Button>
      ) : (
        <div className="space-y-3 rounded-lg bg-white/5 p-3">
          <label className="block space-y-1">
            <span className="text-fg">The board's address, as the phone reaches it</span>
            <Input
              className="font-mono text-[11.5px]"
              placeholder="https://machine.tailnet.ts.net"
              value={address ?? defaultAddress(publicUrl)}
              onChange={(e) => setAddress(e.target.value)}
            />
          </label>
          {plainHttp && (
            <p className="text-amber-200">
              Phones refuse plain HTTP: serve the board over HTTPS (<code>tailscale serve --bg 7878</code>) and use that address.
            </p>
          )}
          {left > 0 ? (
            link ? (
              <div className="flex flex-wrap items-start gap-4">
                <QrSvg text={link} />
                <div className="min-w-0 flex-1 space-y-2">
                  <p className="text-fg">Scan it in the Huntaway app: Boards → Pair a board.</p>
                  <p>
                    Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}. Or paste the link into the app:
                  </p>
                  <div className="flex items-center gap-2">
                    <Input readOnly className="font-mono text-[11px]" value={link} aria-label="Pairing link" />
                    <Button size="sm" onClick={() => copyText(link)}>
                      Copy
                    </Button>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => setPairing(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-amber-200">Enter the address the phone opens the board at, starting with https://.</p>
            )
          ) : (
            <div className="flex items-center gap-2">
              <span>The code has expired.</span>
              <Button size="sm" onClick={start}>
                New code
              </Button>
            </div>
          )}
        </div>
      )}
      {err && <p className="text-red-400">{err}</p>}
      {devices && devices.length > 0 && (
        <div className="space-y-2">
          <div className="text-[12px] font-medium text-fg">Paired devices</div>
          {devices.map((d) => (
            <div key={d.id} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2" aria-label={`Device ${d.name}`}>
              {renaming?.id === d.id ? (
                <form
                  className="flex min-w-0 flex-1 items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void rename();
                  }}
                >
                  <Input autoFocus value={renaming.name} onChange={(e) => setRenaming({ id: d.id, name: e.target.value })} aria-label="Device name" />
                  <Button size="sm" type="submit">
                    Save
                  </Button>
                  <Button size="sm" variant="ghost" type="button" onClick={() => setRenaming(null)}>
                    Cancel
                  </Button>
                </form>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate text-fg">{d.name}</span>
                  <span className="shrink-0 text-faint">{d.last_used_at ? `used ${timeAgo(d.last_used_at)}` : `paired ${timeAgo(d.created_at)}`}</span>
                  <IconButton title={`Rename ${d.name}`} onClick={() => setRenaming({ id: d.id, name: d.name })}>
                    <Pencil size={13} />
                  </IconButton>
                  <IconButton
                    title={`Revoke ${d.name}`}
                    onClick={() =>
                      ask({
                        title: `Revoke ${d.name}?`,
                        body: <p>It's signed out of this board at once, including anything it has open. Pair it again to use it.</p>,
                        action: "Revoke",
                        danger: true,
                        onConfirm: async () => {
                          await api.revokeDevice(d.id);
                          load();
                        },
                      })
                    }
                  >
                    <X size={14} />
                  </IconButton>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {dialog}
    </div>
  );
}
