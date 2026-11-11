import { Atom } from "effect/reactivity"
import { callRpc, type CallError, type Methods } from "./rpc.ts"

/** What a mutation is run with: the host to call and the method's payload. */
export interface MutationArg<M extends keyof Methods> {
  readonly host: string
  readonly payload: Methods[M]["payload"]
}

/** A method of a host as an `AtomResultFn` a component runs with `useAtomSet` (calls of it run side by side). */
export type Mutation<M extends keyof Methods> = Atom.AtomResultFn<MutationArg<M>, Methods[M]["success"], CallError<M>>

const mutation = <M extends keyof Methods>(method: M): Mutation<M> =>
  Atom.fn<MutationArg<M>>()((arg) => callRpc(arg.host, method, arg.payload), { concurrent: true })

/**
 * The calls that change a host's board (docs/plan/09-frontend.md, Queries, mutations, invalidation). A mutation does
 * not write its answer into the board; the event that follows it does. Moving, reordering and starring a task, which
 * show at once, are `optimisticMove`.
 */
export const mutations = {
  tasks: {
    create: mutation("tasks.create"),
    update: mutation("tasks.update"),
    delete: mutation("tasks.delete"),
    // A composer's sends and unqueues are `sendMessage` and `unqueueMessage` (thread/send.ts), which keep its draft.
    send: mutation("tasks.send"),
    stop: mutation("tasks.stop"),
    dropQueued: mutation("tasks.dropQueued"),
  },
  projects: { create: mutation("projects.create"), update: mutation("projects.update"), delete: mutation("projects.delete") },
  profiles: { create: mutation("profiles.create"), update: mutation("profiles.update"), delete: mutation("profiles.delete") },
  configs: { create: mutation("configs.create"), update: mutation("configs.update"), delete: mutation("configs.delete") },
  pens: { create: mutation("pens.create"), update: mutation("pens.update"), delete: mutation("pens.delete") },
  host: { updateSettings: mutation("host.updateSettings") },
} as const
