import type { HostTask as Task } from "@huntaway/client"
import { useState } from "react"
import { PluginFrame } from "../../../plugins/PluginFrame"
import { usePlugins } from "../../../plugins/usePlugins"
import { Section } from "./Section"

/** HE-34: the plugins' panels for a task (docs/plan/15-plugins.md, Pages), from its host; one with nothing to show is left out. */
export function PluginSections({ task }: { task: Task }) {
  const plugins = usePlugins(task.host_id).filter((p) => p.task && p.error === null)
  return (
    <>
      {plugins.map((p) => (
        <PluginSection key={p.id} task={task} plugin={p.id} title={p.name} />
      ))}
    </>
  )
}

function PluginSection({ task, plugin, title }: { task: Task; plugin: string; title: string }) {
  const [empty, setEmpty] = useState(true)
  const frame = <PluginFrame host={task.host_id} plugin={plugin} slot="task" taskId={task.id} onEmpty={setEmpty} />
  // Drawn while it's empty too (hidden), so the frame is read and can say when it has something.
  return empty ? <div hidden>{frame}</div> : <Section title={title}>{frame}</Section>
}
