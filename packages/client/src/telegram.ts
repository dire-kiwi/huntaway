import { enc, type Http } from "./http";
import { type Host, hostSupports } from "./hosts";

/** Telegram (API 117): a profile's assistant talks to you through a bot of its own, run by the host the assistant is on
 *  (see server-ts/src/integrations/telegram.ts). */
export const TELEGRAM_API = 117;

export const hasTelegram = (h: Host | undefined) => hostSupports(h, TELEGRAM_API);

/** What the bot sends you, besides its replies to what you send it (which always come back). */
export type TelegramEvents = {
  /** The assistant's replies to messages sent from the board too. */
  replies: boolean;
  /** Its routines' reports. */
  reports: boolean;
  /** Its permission prompts (with Allow and Deny), its questions, and its routines' prompts. */
  prompts: boolean;
  /** It needs attention (its run failed, say). */
  attention: boolean;
};

export type Telegram = {
  /** A bot token is set. The token itself is never shown. */
  configured: boolean;
  bot: { id: number; username: string } | null;
  /** The chat it's linked to: the only one it listens to and writes to. */
  owner: { name: string; username: string | null; linked_at: string } | null;
  events: TelegramEvents;
  /** A linking code is waiting to be sent, until then. */
  linking: { expires_at: string } | null;
  /** Why talking to Telegram last failed, until it works again. */
  last_error: string | null;
  /** Messages and button presses from others, dropped. */
  dropped: { count: number; last_from: string; last_at: string } | null;
  /** Its host is reading the bot's messages. */
  polling: boolean;
  /** Messages waiting to be sent (kept, and tried again, while Telegram can't be reached). */
  queued: number;
};

/** A one-time code to send the bot, which links the chat it's sent from. */
export type TelegramLink = { code: string; command: string; url: string | null; expires_at: string };

export const telegramApi = ({ on }: Http) => ({
  telegram: (h: string, profileId: string) => on(h).get<Telegram>(`/profiles/${enc(profileId)}/telegram`),
  /** Set the bot's token (`null` removes the bot) or what it sends. */
  setTelegram: (h: string, profileId: string, body: { token?: string | null; events?: TelegramEvents }) =>
    on(h).patch<Telegram>(`/profiles/${enc(profileId)}/telegram`, body),
  telegramLink: (h: string, profileId: string) => on(h).post<TelegramLink>(`/profiles/${enc(profileId)}/telegram/link`, {}),
  unlinkTelegram: (h: string, profileId: string) => on(h).del<Telegram>(`/profiles/${enc(profileId)}/telegram/owner`),
});
