import { useBoard } from "../../state/board"
import { unavailableNote, useAssistant } from "./assistant"
import { AssistantHostPicker } from "./AssistantHostPicker"
import { TaskView } from "./TaskView"

/** `/assistant/<profile>`: the profile's assistant, full width, made by its host the first time it's opened. */
export function AssistantPage({ profile }: { profile: string }) {
  const { taskId, error, missing, home } = useAssistant(profile)
  const loaded = useBoard((s) => s.loaded)
  const hostName = useBoard((s) => s.hosts.find((h) => h.id === home?.hostId)?.name ?? "its host")
  if (taskId) return <TaskView key={taskId} taskId={taskId} />
  return (
    <div className="flex h-full flex-col">
      {/* Where it runs can be changed here too: away from a host that's offline or has no such profile. */}
      <div className="drag flex h-12 shrink-0 items-center justify-end border-b border-line px-3">
        <AssistantHostPicker profile={profile} />
      </div>
      <div className="p-8 text-muted">
        {error
          ? `Couldn't open ${profile}'s assistant: ${error}`
          : home?.unavailable && loaded
            ? unavailableNote(profile, hostName, home.unavailable)
            : missing && loaded
              ? `${profile} has no assistant: its host is offline.`
              : "Opening the assistant…"}
      </div>
    </div>
  )
}
