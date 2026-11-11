import { clsx } from "clsx"
import { Plus, Settings, Star, X } from "lucide-react"
import { useMemo, useState } from "react"
import { useDrawer } from "../../narrow"
import { type Route } from "../../router"
import { navigate } from "../../state/route"
import { profileNames } from "../boardHelpers"
import { ArchiveProjectModal } from "../settings/ArchivedProjects"
import { NewProjectModal } from "../settings/NewProjectModal"
import { ReloadButton } from "../settings/Server"
import { UsagePanel } from "../settings/Usage"
// 6.3
import { DocsEntry } from "./sidebar/DocsEntry"
// 6.7
import { AssistantEntry } from "./sidebar/AssistantEntry"
import { ContextMenu, IconButton } from "../ui"
import { GroupNameModal } from "./sidebar/GroupNameModal"
import { HostProjects } from "./sidebar/HostProjects"
import { MarkedTasks } from "./sidebar/MarkedTasks"
import { NavItem } from "./sidebar/NavItem"
import { ProfileNav } from "./sidebar/ProfileNav"
import { ProjectRow, type RowProps } from "./sidebar/ProjectRow"
import { useActiveProfile } from "./sidebar/useActiveProfile"
import { useCollapsedGroups } from "./sidebar/useCollapsedGroups"
import { useGroupActions } from "./sidebar/useGroupActions"
import { useProfileOf } from "./sidebar/useProfileOf"
import { useProjectLists } from "./sidebar/useProjectLists"
import { useProjectMarks } from "./sidebar/useProjectMarks"
import { useProjectMenus } from "./sidebar/useProjectMenus"
import { usePageShortcuts } from "./usePageShortcuts"
import { useSidebarStats } from "./sidebar/useSidebarStats"
import { useBoard } from "../../state/board"

/** `drawer`: in the narrow layout's drawer, which it fills. */
export function Sidebar({ route, drawer }: { route: Route; drawer?: boolean | undefined }) {
  const profiles = useBoard((s) => s.profiles)
  const hosts = useBoard((s) => s.hosts)
  const projects = useBoard((s) => s.projects)
  const tasks = useBoard((s) => s.tasks)
  const connected = useBoard((s) => s.connected)
  const { collapsed, setCollapsedGroup } = useCollapsedGroups()
  const marks = useProjectMarks()
  const { hidden, showHidden, setShowHidden, isPinned, isFavorite } = marks
  const profileOf = useProfileOf(profiles)
  const stats = useSidebarStats(tasks, profileOf)

  const routeTask = route.name === "task" ? tasks[route.taskId] : undefined
  const activeProject = "projectId" in route ? route.projectId : routeTask?.project_id
  const names = profileNames(profiles)
  const taskList = useMemo(() => Object.values(tasks), [tasks])
  const active = useActiveProfile({ route, routeTask, names, profiles, projects, taskList, profileOf, isPinned })
  usePageShortcuts(active)
  const { shown, favoriteList, groups, grouped } = useProjectLists({ hosts, projects, taskList, active, profileOf, marks })
  const { naming, setNaming, groupErr, setGroupErr, leaveGroup, trySetGroup, saveName } = useGroupActions({ route, collapsed, setCollapsedGroup })
  const { menu, setMenu, archiving, setArchiving, projectMenu, groupMenu } = useProjectMenus({
    projects,
    names,
    marks,
    trySetGroup,
    leaveGroup,
    setNaming,
  })
  // Add project (6.11).
  const [adding, setAdding] = useState(false)
  const row: RowProps = { stats: stats.by, hosts, grouped, active, activeProject, profileOf, isPinned, isFavorite, projectMenu }

  return (
    <aside className={clsx("flex h-full shrink-0 flex-col border-r border-line bg-panel", drawer ? "w-full" : "w-60")}>
      <div className="drag flex h-12 items-center gap-2 px-4">
        <img src="/icon.svg" className="h-5 w-5" alt="" />
        <span className="text-[13.5px] font-semibold tracking-tight">Huntaway</span>
        <span
          title={connected ? "Connected" : "Reconnecting…"}
          className={clsx("ml-auto h-1.5 w-1.5 rounded-full", connected ? "bg-emerald-400" : "bg-red-400 animate-pulse-dot")}
        />
        {drawer && (
          <IconButton className="-mr-2" title="Close the menu" onClick={() => useDrawer.getState().setOpen(false)}>
            <X size={18} />
          </IconButton>
        )}
      </div>

      <ProfileNav route={route} names={names} active={active} byProfile={stats.byProfile} setMenu={setMenu} />

      <div className="mt-4 min-h-0 flex-1 overflow-y-auto px-2">
        {/* 6.7: the profile's assistant; 6.3: its documents. */}
        {active && (
          <div className="space-y-0.5 pb-3 empty:hidden">
            <AssistantEntry route={route} profile={active} />
            <DocsEntry route={route} profile={active} />
          </div>
        )}
        <MarkedTasks route={route} />
        {favoriteList.length > 0 && (
          <div className="pb-3">
            <div className="flex h-6 items-center gap-1.5 px-2 pb-1 text-[11px] font-semibold tracking-wide text-faint uppercase">
              <Star size={11} className="shrink-0" />
              Favorites
            </div>
            <div role="group" aria-label="Favorites" className="space-y-0.5">
              {favoriteList.map((p) => (
                <div key={`${p.host_id}:${p.id}`} className="flex">
                  <ProjectRow p={p} {...row} />
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="flex items-center px-2 pb-1">
          <span className="min-w-0 truncate text-[11px] font-semibold tracking-wide text-faint uppercase">
            Projects
            {names.length > 1 && active && (
              <span className="font-normal tracking-normal normal-case" title={`${active}'s projects, and the pinned ones`}>
                {" · "}
                <span className="text-accent">{active}</span>
              </span>
            )}
          </span>
          <IconButton className="ml-auto h-6 w-6" title="Add project" onClick={() => setAdding(true)}>
            <Plus size={14} />
          </IconButton>
        </div>
        <div className="space-y-0.5">
          {groups.map((group) => (
            <HostProjects
              key={group.host.id}
              group={group}
              route={route}
              hidden={hidden}
              showHidden={showHidden}
              setShowHidden={setShowHidden}
              collapsed={collapsed}
              setCollapsedGroup={setCollapsedGroup}
              groupMenu={groupMenu}
              row={row}
            />
          ))}
          {groupErr && (
            <div className="flex items-start gap-1 px-2.5 py-1 text-[11.5px] text-red-400">
              <span className="min-w-0 flex-1">{groupErr}</span>
              <IconButton className="h-5 w-5" title="Dismiss" onClick={() => setGroupErr(null)}>
                <X size={12} />
              </IconButton>
            </div>
          )}
          {shown.length === 0 && (
            <div className="w-full rounded-md border border-dashed border-line px-3 py-3 text-center text-[12px] text-faint">
              {projects.length === 0 ? "No projects yet" : `No projects in ${active ?? "this profile"} yet`}
            </div>
          )}
        </div>
      </div>

      <UsagePanel profile={active} />
      {/* The update button (settings/Server's UpdateButton) comes with the update area (admin.*, HE-6). */}
      <div className="border-t border-line p-2">
        <ReloadButton />
        <NavItem active={route.name === "settings"} onClick={() => navigate({ name: "settings" })} icon={<Settings size={15} />}>
          Settings
        </NavItem>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} title={menu.title} items={menu.items} onClose={() => setMenu(null)} />}
      {archiving && <ArchiveProjectModal project={archiving} onClose={() => setArchiving(null)} />}
      {adding && <NewProjectModal profile={active} onClose={() => setAdding(false)} />}
      {naming && <GroupNameModal title={naming.title} initial={naming.initial} onClose={() => setNaming(null)} onSave={saveName} />}
    </aside>
  )
}
