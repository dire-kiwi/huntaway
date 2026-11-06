import { Copy, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type Task, type Telegram, type TelegramEvents, type TelegramLink } from "../../api";
import { onTelegram } from "../../store";
import { Ago, Button, copyText, IconButton, Input, useAsyncAction, useConfirm } from "../ui";

/** A profile's Telegram bot on its assistant's host (API 117), loaded and kept up to date as it changes there. */
function useTelegram(hostId: string, profileId: string) {
  const [tg, setTg] = useState<Telegram | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      api.telegram(hostId, profileId).then(
        (t) => live && (setTg(t), setError(null)),
        (e: Error) => live && setError(e.message),
      );
    load();
    const off = onTelegram((h, p) => {
      if (h === hostId && p === profileId) load();
    });
    return () => {
      live = false;
      off();
    };
  }, [hostId, profileId]);
  return { tg, setTg, error };
}

/** What the bot can send, which push sends too (to the devices that chose it in Settings → Notifications): each goes by
 *  push alone, or by push and Telegram. */
const PUSHED: { key: keyof TelegramEvents; label: string }[] = [
  { key: "prompts", label: "Its prompts (Allow and Deny) and questions" },
  { key: "attention", label: "When it needs attention" },
  { key: "reports", label: "Its routines' reports" },
  { key: "replies", label: "Its replies to what you send from the board" },
];

/** The assistant's Telegram, in its details: the bot's token, the chat it's linked to, and what it sends there. */
export function TelegramSection({ task }: { task: Task }) {
  const { tg, setTg, error } = useTelegram(task.host_id, task.profile_id);
  const [token, setToken] = useState("");
  const [changing, setChanging] = useState(false);
  const [link, setLink] = useState<TelegramLink | null>(null);
  const act = useAsyncAction();
  const { ask, dialog } = useConfirm();
  const h = task.host_id;
  const p = task.profile_id;
  // Linked meanwhile (from Telegram): the code has done its job.
  const owner = tg?.owner?.linked_at;
  useEffect(() => setLink(null), [owner]);
  if (error) return <div className="text-[12px] text-red-400">Couldn't load Telegram: {error}</div>;
  if (!tg) return <div className="text-[12px] text-faint">Loading…</div>;

  const saveToken = () =>
    act.run(async () => {
      if (!token.trim()) throw new Error("Paste the bot's token from @BotFather");
      setTg(await api.setTelegram(h, p, { token: token.trim() }));
      setToken("");
      setChanging(false);
    });
  const tokenForm = (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        saveToken();
      }}
    >
      <Input
        type="password"
        autoComplete="off"
        value={token}
        aria-label="Bot token"
        placeholder="123456789:AAH… from @BotFather"
        className="h-7 flex-1 font-mono text-[12px]"
        onChange={(e) => setToken(e.target.value)}
      />
      <Button size="sm" type="submit" disabled={act.busy || !token.trim()}>
        Save token
      </Button>
      {changing && (
        <Button size="sm" variant="ghost" onClick={() => (setChanging(false), setToken(""))}>
          Cancel
        </Button>
      )}
    </form>
  );

  if (!tg.configured) {
    return (
      <div className="space-y-2 text-[12.5px] text-muted">
        <div>
          Talk to the assistant from Telegram, and have it reach you there. Make a bot with{" "}
          <a className="text-accent hover:underline" href="https://t.me/BotFather" target="_blank" rel="noreferrer">
            @BotFather
          </a>{" "}
          (<code>/newbot</code>) and paste its token here. It's kept on the assistant's host and never shown again.
        </div>
        {tokenForm}
        {act.error && <div className="text-[12px] text-red-400">{act.error}</div>}
      </div>
    );
  }

  const newCode = () =>
    act.run(async () => {
      const l = await api.telegramLink(h, p);
      setTg(await api.telegram(h, p));
      setLink(l);
    });
  // The code only while the host still waits for it: one sent from a group is spent there (HA-207 review).
  const code = link && tg.linking?.expires_at === link.expires_at ? link : null;
  const unlink = () =>
    ask({
      title: "Unlink Telegram?",
      body: "The bot stops listening to that chat until you link one again.",
      action: "Unlink",
      danger: true,
      onConfirm: async () => setTg(await api.unlinkTelegram(h, p)),
    });
  const remove = () =>
    ask({
      title: "Remove the bot?",
      body: "Its token is deleted from the assistant's host, and it stops listening to Telegram.",
      action: "Remove",
      danger: true,
      onConfirm: async () => setTg(await api.setTelegram(h, p, { token: null })),
    });
  const setEvent = (key: keyof TelegramEvents, on: boolean) => act.run(async () => setTg(await api.setTelegram(h, p, { events: { ...tg.events, [key]: on } })));
  const bot = tg.bot?.username ? `@${tg.bot.username}` : "The bot";

  return (
    <div className="space-y-2.5 text-[12.5px] text-muted">
      <div>
        {tg.bot?.username ? (
          <a className="text-fg hover:underline" href={`https://t.me/${tg.bot.username}`} target="_blank" rel="noreferrer">
            {bot}
          </a>
        ) : (
          bot
        )}
        {tg.owner ? (
          <>
            {" "}
            is linked to <span className="text-fg">{tg.owner.name}</span>
            {tg.owner.username && <> (@{tg.owner.username})</>}, <Ago at={tg.owner.linked_at} />. What you send it goes to the assistant.
          </>
        ) : (
          " isn't linked to a chat yet: it listens to nobody until you link one."
        )}
        {!tg.polling && <span className="text-st-attention"> Its host isn't reading its messages.</span>}
      </div>

      {code ? (
        <div className="space-y-1.5 rounded-md border border-line bg-panel-2/60 p-2.5" aria-label="Linking code">
          <div>
            Send this to {bot} from a private chat with it, within ten minutes (until {new Date(code.expires_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}):
          </div>
          <div className="flex items-center gap-1.5">
            <code className="rounded bg-panel px-2 py-1 font-mono text-[12.5px] whitespace-nowrap text-fg select-all">{code.command}</code>
            <IconButton title="Copy" onClick={() => copyText(code.command)}>
              <Copy size={13} />
            </IconButton>
            {code.url && (
              <a className="inline-flex items-center gap-1 text-accent hover:underline" href={code.url} target="_blank" rel="noreferrer">
                Open in Telegram <ExternalLink size={12} />
              </a>
            )}
          </div>
          <div className="text-faint">It links the chat it's sent from, in place of any linked before, and works once.</div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={newCode} disabled={act.busy}>
            {tg.owner ? "Link another chat…" : "Link a chat…"}
          </Button>
          {tg.owner && (
            <Button size="sm" variant="ghost" onClick={unlink} disabled={act.busy}>
              Unlink
            </Button>
          )}
        </div>
      )}

      <div className="space-y-1.5" aria-label="What it sends">
        <div className="text-fg">Its replies to what you send there come back. Besides:</div>
        {PUSHED.map((e) => (
          <label key={e.key} className="flex items-center justify-between gap-2">
            <span>{e.label}</span>
            <select
              className="h-7 shrink-0 rounded-md border border-line bg-panel px-1.5 text-[12px] text-fg outline-none"
              value={tg.events[e.key] ? "both" : "push"}
              aria-label={`Where ${e.label.toLowerCase()} go`}
              onChange={(ev) => setEvent(e.key, ev.target.value === "both")}
            >
              <option value="push">Push</option>
              <option value="both">Push and Telegram</option>
            </select>
          </label>
        ))}
        <div className="text-faint">
          Push goes to the devices that chose these in Settings → Notifications (replies are off there until chosen). Replies to what you send
          here aren't pushed.
        </div>
      </div>

      {tg.last_error && (
        <div className="rounded bg-red-500/10 p-2 text-[12px] text-red-300">
          Telegram: {tg.last_error}
          {tg.queued > 0 && <> ({tg.queued} message{tg.queued === 1 ? "" : "s"} waiting, to be tried again)</>}
        </div>
      )}
      {tg.dropped && (
        <div className="text-faint">
          Turned away {tg.dropped.count} message{tg.dropped.count === 1 ? "" : "s"} or button press{tg.dropped.count === 1 ? "" : "es"} from others, the last
          from {tg.dropped.last_from} <Ago at={tg.dropped.last_at} />.
        </div>
      )}
      {changing ? (
        tokenForm
      ) : (
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => setChanging(true)}>
            Change token…
          </Button>
          <Button size="sm" variant="ghost" onClick={remove} disabled={act.busy}>
            Remove bot
          </Button>
        </div>
      )}
      {act.error && <div className="text-[12px] text-red-400">{act.error}</div>}
      {dialog}
    </div>
  );
}
