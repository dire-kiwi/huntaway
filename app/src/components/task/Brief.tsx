// The assistant's Brief tab (API 104): the morning brief its routine writes (brief.html, one version a day), with a thumbs up and
// down on each item the run marked, which go into MEMORY.md as preferences (see server/src/agent/assistant/brief.rs). Without a
// brief yet, it sets up the routine.
import clsx from "clsx";
import { Loader2, Newspaper, Play } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, WEEKDAYS, type Automation, type BriefRating, type Task, type TaskDocument, type Weekday } from "../../api";
import { onAutomationsChanged } from "../../store";
import { localTime, timeUntil, triggerText, type TimeZone } from "../settings/Automations";
import { Button } from "../ui";

/** The routine the template makes is called this (brief.rs's NAME). */
const BRIEF_NAME = "Morning brief";

type Rated = Record<string, "up" | "down">;

/** A rated item's key: its kind and topic, as MEMORY.md keeps one line for each. */
const itemKey = (kind: string, topic: string) => `${kind}:${topic}`.toLowerCase();

const storeKey = (hostId: string, taskId: string) => `ia.briefRatings:${hostId}:${taskId}`;

function loadRated(hostId: string, taskId: string): Rated {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(storeKey(hostId, taskId)) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Rated) : {};
  } catch {
    return {};
  }
}

function saveRated(hostId: string, taskId: string, r: Rated) {
  try {
    localStorage.setItem(storeKey(hostId, taskId), JSON.stringify(r));
  } catch {
    // Storage full or unavailable: the ratings are in memory regardless.
  }
}

/**
 * What runs in the brief's frame (as source, so it can't use anything from outside): a thumbs up and down on each element with
 * `data-brief-item`, which posts the user's click (and only a real click) to the board with `token`, and shows `rated`.
 */
function iaBrief(token: string, rated: Record<string, string>) {
  const style = document.createElement("style");
  style.textContent =
    ".ia-rate{display:inline-flex;gap:2px;margin-left:.5em;vertical-align:middle;opacity:.45;transition:opacity .15s}" +
    "[data-brief-item]:hover>.ia-rate,.ia-rate:focus-within,.ia-rate.ia-on{opacity:1}" +
    ".ia-rate button{all:unset;cursor:pointer;font-size:13px;line-height:1;padding:2px 3px;border-radius:4px;filter:grayscale(1)}" +
    ".ia-rate button:hover{background:rgba(127,127,127,.18)}.ia-rate button[aria-pressed=true]{filter:none;background:rgba(127,127,127,.22)}";
  document.head.append(style);
  const keyOf = (kind: string, topic: string) => `${kind}:${topic}`.toLowerCase();
  const items: { key: string; buttons: HTMLButtonElement[]; box: HTMLElement }[] = [];
  const show = () => {
    for (const it of items) {
      const r = rated[it.key];
      it.buttons[0].setAttribute("aria-pressed", String(r === "up"));
      it.buttons[1].setAttribute("aria-pressed", String(r === "down"));
      it.box.classList.toggle("ia-on", !!r);
    }
  };
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-brief-item]"))) {
    const kind = (el.dataset.briefKind || "other").trim();
    const text = (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 300);
    const topic = (el.dataset.briefTopic || "").trim().slice(0, 300) || text;
    if (!topic) continue;
    const box = document.createElement("span");
    box.className = "ia-rate";
    const key = keyOf(kind, topic);
    const buttons = (["up", "down"] as const).map((rating) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = rating === "up" ? "👍" : "👎";
      b.title = rating === "up" ? "More like this" : "Less like this";
      b.setAttribute("aria-label", `${b.title}: ${topic}`);
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!e.isTrusted) return;
        const next = rated[key] === rating ? "clear" : rating;
        if (next === "clear") delete rated[key];
        else rated[key] = next;
        show();
        parent.postMessage({ iaBrief: { kind, topic, text, rating: next }, token }, "*");
      });
      return b;
    });
    box.append(...buttons);
    // In a table row, in its last cell.
    (el.tagName === "TR" ? (el.lastElementChild as HTMLElement | null) ?? el : el).append(box);
    items.push({ key, buttons, box });
  }
  addEventListener("message", (e) => {
    if (e.source === parent && e.data?.iaBriefRated && typeof e.data.iaBriefRated === "object") {
      for (const k of Object.keys(rated)) delete rated[k];
      Object.assign(rated, e.data.iaBriefRated);
      show();
    }
  });
  show();
}

const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * The brief as its frame shows it. Its own scripts don't run (a Content-Security-Policy lets only the board's, by its nonce),
 * nothing is fetched from elsewhere (no tracking pixels from mail), links open in a new tab, and a meta refresh is taken out, so
 * what the run wrote from mail can't act in the page or rate items. The policy goes first, after any doctype, so it covers it all.
 */
export function briefDoc(html: string, nonce: string, token: string, rated: Rated): string {
  const csp =
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; font-src data:; ` + "form-action 'none'; base-uri 'none'";
  const head = `<meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank">`;
  const body = html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?\s*refresh[^>]*>/gi, "");
  const doctype = /^\s*(?:<!--[\s\S]*?-->\s*)*<!doctype[^>]*>/i.exec(body);
  const at = doctype ? doctype[0].length : 0;
  const script = `<script nonce="${nonce}">(${iaBrief})(${JSON.stringify(token)}, ${JSON.stringify(rated).replace(/</g, "\\u003c")})</script>`;
  return `${body.slice(0, at)}${head}${body.slice(at)}\n${script}`;
}

const dayLabel = (iso: string) => new Date(iso).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });

export function BriefView({ assistant }: { assistant: Task }) {
  const { host_id: hostId, profile_id: profileId, id: taskId } = assistant;
  const [picked, setPicked] = useState<number | null>(null);
  const [doc, setDoc] = useState<TaskDocument | null>(null);
  const [routines, setRoutines] = useState<{ list: Automation[]; tz: TimeZone | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.document(hostId, taskId, "brief", picked ?? undefined).then(
      (d) => live && (setDoc(d), setErr(null)),
      (e) => live && setErr((e as Error).message),
    );
    return () => {
      live = false;
    };
  }, [hostId, taskId, picked, assistant.document_at]);
  const loadRoutines = useCallback(
    () =>
      api.routines(hostId, profileId).then(
        (r) => setRoutines({ list: r.automations, tz: r.time_zone }),
        (e) => setErr((e as Error).message),
      ),
    [hostId, profileId],
  );
  useEffect(() => {
    void loadRoutines();
    return onAutomationsChanged((h, projectId, _id, profile) => {
      if (h === hostId && !projectId && (!profile || profile === profileId)) void loadRoutines();
    });
  }, [loadRoutines, hostId, profileId]);
  const routine = routines?.list.find((a) => a.name === BRIEF_NAME) ?? null;

  const [rated, setRated] = useState<Rated>(() => loadRated(hostId, taskId));
  const ratedRef = useRef(rated);
  ratedRef.current = rated;
  const frame = useRef<HTMLIFrameElement>(null);
  // A new nonce and token each time the page is built: the page can't know either.
  const content = doc?.content ?? null;
  const built = useMemo(() => {
    if (content === null) return null;
    const nonce = randomToken();
    const token = randomToken();
    return { token, html: briefDoc(content, nonce, token, ratedRef.current) };
  }, [content]);
  useEffect(() => {
    const onMessage = async (e: MessageEvent) => {
      if (!built || e.source !== frame.current?.contentWindow || e.data?.token !== built.token) return;
      const item = e.data?.iaBrief as { kind?: unknown; topic?: unknown; text?: unknown; rating?: unknown } | undefined;
      const rating = item?.rating;
      if (!item || (rating !== "up" && rating !== "down" && rating !== "clear")) return;
      const str = (x: unknown) => (typeof x === "string" ? x.slice(0, 300) : undefined);
      const kind = str(item.kind) ?? "other";
      const topic = str(item.topic) ?? "";
      const key = itemKey(kind, topic);
      const before = ratedRef.current;
      const next = { ...before };
      if (rating === "clear") delete next[key];
      else next[key] = rating;
      setRated(next);
      saveRated(hostId, taskId, next);
      try {
        await api.rateBrief(hostId, profileId, rating as BriefRating, { kind, topic, text: str(item.text) });
        setErr(null);
      } catch (x) {
        setErr(`That rating wasn't saved: ${(x as Error).message}`);
        setRated(before);
        saveRated(hostId, taskId, before);
        frame.current?.contentWindow?.postMessage({ iaBriefRated: before }, "*");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [built, hostId, profileId, taskId]);

  const versions = doc?.versions ?? [];
  const latest = versions[versions.length - 1];
  const [running, setRunning] = useState(false);
  const runNow = async () => {
    if (!routine) return;
    setRunning(true);
    try {
      await api.runAutomation(hostId, routine.id);
      setErr(null);
      await loadRoutines();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setRunning(false);
    }
  };
  const lastRun = routine?.last_run;
  const working = lastRun?.task?.running;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="brief">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3 text-[12px]">
        <span className="flex items-center gap-1.5 text-muted narrow:hidden">
          <Newspaper size={12} /> Brief
        </span>
        {versions.length > 0 && (
          <select
            className="h-6 rounded border border-line bg-panel px-1 text-[12px] text-fg outline-none"
            title="One for each day it was written"
            aria-label="Day"
            value={doc?.version ?? ""}
            onChange={(e) => {
              const v = Number(e.target.value);
              setPicked(v === latest?.version ? null : v);
            }}
          >
            {[...versions].reverse().map((v) => (
              <option key={v.version} value={v.version}>
                {dayLabel(v.created_at)}
                {v.version === latest?.version ? " (latest)" : ""}
              </option>
            ))}
          </select>
        )}
        {working && (
          <span className="flex items-center gap-1.5 text-muted">
            <Loader2 size={12} className="animate-spin" /> Writing today's…
          </span>
        )}
        {routine && (
          <span className="ml-auto flex min-w-0 items-center gap-2 text-faint">
            <span className="truncate" title={routine.enabled && routine.next_run_at ? new Date(routine.next_run_at).toLocaleString() : undefined}>
              {routine.enabled ? (routine.next_run_at ? `Next ${timeUntil(routine.next_run_at)} (${localTime(routine.next_run_at)})` : triggerText(routine.trigger, routines?.tz ?? null)) : "Paused"}
            </span>
            <Button size="sm" variant="ghost" disabled={running || !!working} onClick={runNow} title="Write today's brief now">
              {running ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Run now
            </Button>
          </span>
        )}
      </div>
      {err && <div className="shrink-0 bg-red-500/10 px-3 py-1.5 text-[12px] text-red-300">{err}</div>}
      <div className="relative min-h-0 flex-1">
        {doc === null && !err ? (
          <div className="flex h-full items-center justify-center text-muted">
            <Loader2 size={16} className="animate-spin" />
          </div>
        ) : built ? (
          <iframe
            ref={frame}
            title="Morning brief"
            srcDoc={built.html}
            sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
            referrerPolicy="no-referrer"
            className="block h-full w-full bg-white"
          />
        ) : (
          <div className="h-full overflow-y-auto">
            <div className="mx-auto max-w-xl p-8">
              {routines === null ? null : routine ? (
                <div className="rounded-xl border border-dashed border-line p-6 text-center text-[13px] text-muted">
                  No brief yet. {routine.name} runs {triggerText(routine.trigger, routines.tz).replace(/^At/, "at")}: press Run now for one today.
                </div>
              ) : (
                <BriefSetup hostId={hostId} profileId={profileId} onAdded={loadRoutines} />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** The template: the morning brief on the weekdays and at the time picked. */
function BriefSetup({ hostId, profileId, onAdded }: { hostId: string; profileId: string; onAdded: () => void }) {
  const [time, setTime] = useState("07:30");
  const [days, setDays] = useState<Weekday[]>(["mon", "tue", "wed", "thu", "fri"]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const add = async () => {
    setBusy(true);
    try {
      await api.addBrief(hostId, profileId, { time, weekdays: days });
      setErr(null);
      onAdded();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 rounded-xl border border-line p-5 text-[13px]" data-testid="brief-setup">
      <div className="text-fg">A morning brief</div>
      <p className="text-muted">
        Each morning your assistant reads today's calendar, unread and starred mail, Drive files changed lately and what's waiting for you on the
        board, writes a brief here, and sends you a short summary. Rate its items with 👍 and 👎, and later briefs follow your ratings. It needs
        Google (the assistant's Details → Google) for mail, calendar and Drive; it only reads and drafts.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-muted">
          At
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="h-7 rounded-md border border-line bg-panel px-1.5 text-[12.5px] text-fg outline-none"
            aria-label="Time"
          />
        </label>
        <div className="flex items-center gap-1" role="group" aria-label="Days">
          {WEEKDAYS.map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={days.includes(d)}
              onClick={() => setDays(days.includes(d) ? days.filter((x) => x !== d) : WEEKDAYS.filter((x) => x === d || days.includes(x)))}
              className={clsx("h-7 rounded-md border px-2 text-[12px] capitalize", days.includes(d) ? "border-accent/60 bg-accent/15 text-fg" : "border-line text-muted hover:text-fg")}
            >
              {d}
            </button>
          ))}
        </div>
      </div>
      <Button size="sm" variant="primary" disabled={busy || !time || days.length === 0} onClick={add}>
        {busy && <Loader2 size={12} className="animate-spin" />} Add the morning brief
      </Button>
      {err && <div className="text-[12px] text-red-400">{err}</div>}
    </div>
  );
}
