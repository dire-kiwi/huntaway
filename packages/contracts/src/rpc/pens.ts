import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Conflict, Invalid, NotFound } from "../errors.ts"
import { PenId, ProfileId } from "../ids.ts"
import { NewPen, Pen, PenPatch } from "../pen.ts"
import { Auth, RequiredScope } from "../session.ts"
import { Task } from "../task.ts"

/** Pens (the old `/profiles/{id}/pens`, `/pens/{id}`). Each change emits `pens` with the profile's pens. */
export class PenRpcs extends RpcGroup.make(
  Rpc.make("pens.list", { payload: { profile_id: ProfileId }, success: Schema.Array(Pen), error: NotFound }).annotate(RequiredScope, "read"),
  Rpc.make("pens.create", { payload: { pen: NewPen }, success: Pen, error: Schema.Union([NotFound, Invalid, Conflict]) }).annotate(RequiredScope, "operate"),
  Rpc.make("pens.update", { payload: { id: PenId, patch: PenPatch }, success: Pen, error: Schema.Union([NotFound, Invalid, Conflict]) }).annotate(
    RequiredScope,
    "operate",
  ),
  /** Its tasks leave the pen; its thread is deleted. */
  Rpc.make("pens.delete", { payload: { id: PenId }, error: NotFound }).annotate(RequiredScope, "operate"),
  /** The profile's pens thread, made the first time it's asked for (the old `GET /profiles/{id}/pens-thread`); a `task` event when made. */
  Rpc.make("pens.thread", { payload: { profile_id: ProfileId }, success: Task, error: NotFound }).annotate(RequiredScope, "operate"),
  /** The pen's own thread, made the first time it's asked for (the old `GET /pens/{id}/thread`); `task` and `pens` events when made. */
  Rpc.make("pens.penThread", { payload: { id: PenId }, success: Task, error: NotFound }).annotate(RequiredScope, "operate"),
).middleware(Auth) {}
