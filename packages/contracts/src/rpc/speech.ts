import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Conflict, Invalid, NotFound, Unavailable } from "../errors.ts"
import { SpeechStatus, SpeechTranscript } from "../speech.ts"
import { Auth, RequiredScope } from "../session.ts"

/**
 * Dictation (HE-89, speech.ts). Reading the status is `read`, transcribing `operate` (it is typing a message); a
 * download, a removal and the choice of model change what the host has installed, so they are `admin`. Each change
 * answers with the new status; a download goes on in the background, and `speech.status` says how far it has got.
 */
export class SpeechRpcs extends RpcGroup.make(
  Rpc.make("speech.status", { success: SpeechStatus }).annotate(RequiredScope, "read"),
  /** Start downloading `model` (and use it once it's in); `Conflict` while another is downloading. */
  Rpc.make("speech.download", { payload: { model: Schema.String }, success: SpeechStatus, error: Schema.Union([NotFound, Conflict, Unavailable]) }).annotate(
    RequiredScope,
    "admin",
  ),
  /** Stop the download going, if there is one. */
  Rpc.make("speech.cancel", { success: SpeechStatus }).annotate(RequiredScope, "admin"),
  /** Delete an installed model's file. */
  Rpc.make("speech.remove", { payload: { model: Schema.String }, success: SpeechStatus, error: NotFound }).annotate(RequiredScope, "admin"),
  /** Use `model` for dictation; it must be installed. */
  Rpc.make("speech.select", { payload: { model: Schema.String }, success: SpeechStatus, error: NotFound }).annotate(RequiredScope, "admin"),
  /**
   * Transcribe `audio`: base64 of 16 kHz mono 16-bit little-endian PCM, at most `SPEECH_MAX_SECONDS`. `Unavailable`
   * with no model installed or when the engine fails; `Invalid` for audio that isn't PCM or is too long.
   */
  Rpc.make("speech.transcribe", { payload: { audio: Schema.String }, success: SpeechTranscript, error: Schema.Union([Invalid, Unavailable]) }).annotate(
    RequiredScope,
    "operate",
  ),
).middleware(Auth) {}
