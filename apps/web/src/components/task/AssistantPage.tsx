import { useBoard } from "../../state/board"
import { unavailableNote, useAssistant } from "./assistant"
import { TaskView } from "./TaskView"

/** `/assistant/<profile>`: the profile's assistant, full width, made by its host the first time it's opened. */
export function AssistantPage({ profile }: { profile: string }) {
  const { taskId, error, missing, home } = useAssistant(profile)
  const loaded = useBoard((s) => s.loaded)
  const hostName = useBoard((s) => s.hosts.find((h) => h.id === home?.hostId)?.name ?? "its host")
  if (taskId) return <TaskView key={taskId} taskId={taskId} />
  return (
    <div className="flex h-full flex-col">
      <div className="drag h-12 shrink-0 border-b border-line" />
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
