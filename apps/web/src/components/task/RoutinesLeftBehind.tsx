import { Cause, Exit } from "effect"
// The routines this board's own host still has for a profile whose assistant runs on another host (the old Routines
// tab's `LeftBehind`, HA-241, HA-255; 7.4): they don't run there while the assistant is away (the board's host refuses
// them, `RoutineHost.elsewhere`), and that host's routines are the assistant's own, in its Routines tab. Each can be
// deleted from here, since the board no longer opens the assistant they'd wake.
import { useAtomValue } from "@effect/atom-react"
import { automationsAtom, type HostTask as Task, type Methods, mutate } from "@huntaway/client"
import { Trash2 } from "lucide-react"
import { useState } from "react"
import { useBoard } from "../../state/board"
import { runExit } from "../../state/mutation"
import { useShallow } from "../boardHelpers"
import { triggerText } from "../settings/automations/text"
import { Button, errorText, useConfirm } from "../ui"

/** One call to `host`'s board (through the client's `mutate`, which reads again what it changes), as a promise that rejects with the host's error. */
const call = <M extends keyof Methods>(host: string, method: M, payload: Methods[M]["payload"]): Promise<Methods[M]["success"]> =>
  runExit(mutate(method, host, payload)).then((exit) => (Exit.isSuccess(exit) ? exit.value : Promise.reject(Cause.squash(exit.cause))))

/** Under the assistant's own routines: those its profile left on the board's host, if it sends its assistant to `assistant`'s host. */
export function RoutinesLeftBehind({ assistant }: { assistant: Task }) {
  const { host_id: hostId, profile_id: profileId } = assistant
  // The board's own profile of the assistant's name, if it sends its assistant to this host.
  const [boardHost, boardHostName, boardProfile, hostName] = useBoard(
    useShallow((s) => {
      const local = s.hosts.find((h) => h.local)
      const name = s.profiles.find((p) => p.host_id === hostId && p.id === profileId)?.name
      const p =
        local && local.id !== hostId
          ? s.profiles.find((q) => q.host_id === local.id && q.name === name && q.assistant_host !== null && String(q.assistant_host) === hostId)
          : undefined
      return [local?.id, local?.name, p?.id, s.hosts.find((h) => h.id === hostId)?.name ?? hostId] as const
    }),
  )
  if (!boardHost || !boardProfile) return null
  return <LeftBehind boardHost={boardHost} boardHostName={boardHostName ?? boardHost} boardProfile={boardProfile} hostName={hostName} />
}

function LeftBehind({
  boardHost,
  boardHostName,
  boardProfile,
  hostName,
}: {
  boardHost: string
  boardHostName: string
  boardProfile: string
  hostName: string
}) {
  const { data } = useAtomValue(automationsAtom({ host_id: boardHost, profile_id: boardProfile }))
  const list = data?.automations ?? []
  const tz = data?.time_zone ?? null
  const [err, setErr] = useState<string | null>(null)
  const confirm = useConfirm()
  if (!list.length) return null
  return (
    <div className="space-y-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2" data-testid="routines-left-behind">
      <p className="text-[12px] text-muted">
        {list.length === 1 ? "This routine stays" : `These ${list.length} routines stay`} on {boardHostName}, where your assistant ran before, and{" "}
        {list.length === 1 ? "doesn't" : "don't"} run while it's on {hostName}. Add the ones you want again here, and delete them there.
      </p>
      {list.map((a) => (
        <div key={a.id} className="flex items-center gap-3 text-[12.5px]" data-testid="routine-left-behind">
          <span className="min-w-0 flex-1 truncate">
            <span className="font-medium">{a.name}</span> <span className="text-faint">· {triggerText(a.trigger, tz)}</span>
          </span>
          <Button
            size="sm"
            variant="ghost"
            title={`Delete it on ${boardHostName}`}
            onClick={() =>
              confirm.ask({
                title: `Delete routine ${a.name}`,
                body: `Delete the routine "${a.name}" on ${boardHostName}? Its run history goes with it.`,
                action: "Delete routine",
                danger: true,
                onConfirm: () =>
                  call(boardHost, "automations.delete", { id: a.id }).then(
                    () => setErr(null),
                    (e: unknown) => setErr(errorText(e)),
                  ),
              })
            }
          >
            <Trash2 size={13} />
          </Button>
        </div>
      ))}
      {err && <div className="text-xs text-red-400">{err}</div>}
      {confirm.dialog}
    </div>
  )
}
