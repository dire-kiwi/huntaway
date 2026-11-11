import { useProject } from "../../boardHelpers"
import { MenuButton, NotYet } from "../../ui"
import { ProjectWorkflows } from "../Workflows"

// Placeholder: 6.12 brings this page over (docs/plan/13-milestones.md).
export function ProjectSettings({ projectId, tab }: { projectId: string; tab?: string | undefined }) {
  // 6.6: mounted here until 6.12 brings this page over
  const project = useProject(projectId)
  if (tab === "workflows" && project)
    return (
      <div className="h-full overflow-y-auto">
        <div className="flex h-12 items-center border-b border-line px-3">
          <MenuButton />
          <span className="text-[13px] font-medium">{project.name} · Workflows</span>
        </div>
        <div className="mx-auto max-w-3xl p-5">
          <ProjectWorkflows project={project} />
        </div>
      </div>
    )
  return (
    <>
      <div className="flex h-12 items-center border-b border-line px-3">
        <MenuButton />
      </div>
      <NotYet what="Project settings" />
    </>
  )
}
