import { useAssistant } from "../../assistant";
import { useStore } from "../../store";
import { TaskView } from "./TaskView";

/** `/assistant/<profile>`: the profile's assistant, full width, made by its host the first time it's opened. */
export function AssistantPage({ profile }: { profile: string }) {
  const { taskId, error, missing } = useAssistant(profile);
  const loaded = useStore((s) => s.loaded);
  if (taskId) return <TaskView key={taskId} taskId={taskId} />;
  return (
    <div className="flex h-full flex-col">
      <div className="drag h-12 shrink-0 border-b border-line" />
      <div className="p-8 text-muted">
        {error
          ? `Couldn't open ${profile}'s assistant: ${error}`
          : missing && loaded
            ? `${profile} has no assistant: its host is offline or older than the board.`
            : "Opening the assistant…"}
      </div>
    </div>
  );
}
