import { enc, type Http } from "./http";
import { type Host, hostSupports } from "./hosts";
import type { Task } from "./tasks";

/** Pens (API 125): a profile's named sets of tasks from any of its projects, which its board shows as tabs (see
 *  apps/server/src/api/pens.ts). A task is in one pen at most (`Task.pen_id`). Each host keeps its own; a board spanning
 *  hosts merges them by name. */
export const PENS_API = 125;

export const hasPens = (h: Host | undefined) => hostSupports(h, PENS_API);

export type Pen = {
  id: string;
  profile_id: string;
  name: string;
  /** Where its tab goes among the profile's pens' (lowest first). */
  position: number;
  /** Left out of the board's tabs (its tasks stay in it). */
  hidden: boolean;
  created_at: string;
  updated_at: string;
  task_count: number;
};

/** A profile's pens thread (API 125): the one thread that arranges its pens, off the board's columns, keyed `S-<n>`. */
export const isPensThread = (t: Pick<Task, "kind" | "task_type">) => t.kind === "task" && t.task_type === "pens";

export const pensApi = ({ on }: Http) => ({
  pens: (h: string, profileId: string) => on(h).get<Pen[]>(`/profiles/${enc(profileId)}/pens`),
  createPen: (h: string, profileId: string, b: { name: string; hidden?: boolean }) => on(h).post<Pen>(`/profiles/${enc(profileId)}/pens`, b),
  /** `index` moves its tab to that place among the profile's pens (from 0). */
  updatePen: (h: string, id: string, b: { name?: string; hidden?: boolean; index?: number }) => on(h).patch<Pen>(`/pens/${enc(id)}`, b),
  deletePen: (h: string, id: string) => on(h).del(`/pens/${enc(id)}`),
  /** The profile's pens thread, which the host makes the first time it's asked for. */
  pensThread: (h: string, profileId: string) => on(h).get<Task>(`/profiles/${enc(profileId)}/pens-thread`),
});
