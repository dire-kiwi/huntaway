import { isAssistant, isGroupTask, isRoutine } from "@huntaway/client"
import { clsx } from "clsx"
import { lazy, Suspense, useEffect } from "react"
import { activeProfile, loadActiveProfile } from "./activeProfile"
import { Board, GroupBoard, ProfileBoard } from "./components/board/Board"
import { profileNames, useProfileName } from "./components/boardHelpers"
import { Sidebar } from "./components/layout/Sidebar"
import { UnhandledErrors } from "./components/layout/UnhandledErrors"
import { DocsPage } from "./components/docs/DocsPage"
import { Analytics } from "./components/settings/Analytics"
import { Guide } from "./components/settings/Guide"
import { HostPage } from "./components/settings/HostPage"
import { Onboarding } from "./components/settings/Onboarding"
import { ProjectSettings } from "./components/settings/project/ProjectSettings"
import { Settings } from "./components/settings/Settings"
import { TokenScreen } from "./components/settings/TokenScreen"
import { AssistantPage } from "./components/task/AssistantPage"
import { TaskModal, TaskPanel, TaskView } from "./components/task/TaskView"
// 6.1
import { startToolKeepalive } from "./components/task/terminalTools"
import { useDrawer, useNarrow } from "./narrow"
import { boardTaskUrl, groupTaskUrl, hasPanel, profileTaskUrl } from "./router"
import { useBoard } from "./state/board"
import { navigate, usePanel, useRoute, useTaskModal } from "./state/route"

// 6.11: the compare view of the tasks made from one prompt, in a chunk of its own.
const CompareView = lazy(() => import("./components/changes/Compare").then((m) => ({ default: m.CompareView })))

export function App() {
  const authed = useBoard((s) => s.authed)
  const profiles = useBoard((s) => s.profiles)
  const loaded = useBoard((s) => s.loaded)
  const route = useRoute()
  const panel = usePanel()
  const modal = useTaskModal()
  const routeTask = useBoard((s) => (route.name === "task" ? s.tasks[route.taskId] : undefined))
  const narrow = useNarrow()
  const drawerOpen = useDrawer((d) => d.open)
  // 6.1: the terminal tools this board has open are kept while the app is open.
  useEffect(() => {
    if (authed) startToolKeepalive()
  }, [authed])

  // Home is the board of the profile picked last (or the first one), which has every one of its tasks.
  const homeProfile = activeProfile(profileNames(profiles), loadActiveProfile())
  useEffect(() => {
    if (route.name === "home" && homeProfile !== undefined && loaded) navigate(`/profile/${encodeURIComponent(homeProfile)}`, { replace: true })
  }, [route.name, homeProfile, loaded])

  // A group task opens beside its group's board, which stays while the group has group tasks.
  const routeGroup = routeTask && isGroupTask(routeTask) ? (routeTask.group_name ?? undefined) : undefined
  // Any other task in no project (a scratch task) beside its profile's board.
  const routeProfile = useProfileName(routeTask)

  // Tasks open beside their board, so a task's own page moves there once its project is known.
  useEffect(() => {
    if (!routeTask) return
    // A profile's assistant has a page of its own; its routines' threads are on no board.
    if (isAssistant(routeTask)) {
      if (routeProfile !== undefined) navigate(`/assistant/${encodeURIComponent(routeProfile)}`, { replace: true })
      return
    }
    if (isRoutine(routeTask)) return
    if (routeGroup !== undefined) return navigate(groupTaskUrl(routeTask.host_id, routeGroup, routeTask.id), { replace: true })
    if (routeTask.kind === "task" && !routeTask.project_id && routeProfile !== undefined)
      return navigate(profileTaskUrl(routeProfile, routeTask.id), { replace: true })
    if (routeTask.project_id) navigate(boardTaskUrl(routeTask.project_id, routeTask.id), { replace: true })
  }, [routeTask, routeGroup, routeProfile])

  // The narrow layout's drawer closes once it's taken you somewhere, and when the window gets wide enough for the sidebar.
  const page = `${route.name}:${"profile" in route ? route.profile : ""}:${"projectId" in route ? route.projectId : ""}:${"taskId" in route ? route.taskId : ""}`
  const panelTask = panel?.taskId
  useEffect(() => useDrawer.getState().setOpen(false), [page, panelTask, narrow])
  useEffect(() => {
    if (!drawerOpen) return undefined
    const onKey = (e: KeyboardEvent): void => {
      // Not while a dialog or menu of its own is open.
      if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector("[data-modal], [data-task-modal]")) useDrawer.getState().setOpen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [drawerOpen])

  if (authed === false) return <TokenScreen />
  if (authed === null) return null
  // A board with none of its own can still link hosts that have some (Settings → Hosts, M7).
  if (profiles.length === 0) {
    if (!loaded) return null
    return route.name === "settings" ? <Settings tab={route.tab} /> : <Onboarding />
  }

  return (
    <div className="relative flex h-full">
      {narrow ? (
        // A drawer over the page, which stays mounted closed so its menus and dialogs, and its scroll, stay as they were.
        <>
          {drawerOpen && <div className="absolute inset-0 z-40 bg-black/60" onClick={() => useDrawer.getState().setOpen(false)} />}
          <div
            inert={!drawerOpen}
            className={clsx(
              "absolute inset-y-0 left-0 z-40 w-[min(85%,300px)] shadow-2xl shadow-black/50 transition-[translate,visibility] duration-200",
              !drawerOpen && "invisible -translate-x-full",
            )}
          >
            <Sidebar route={route} drawer />
          </div>
        </>
      ) : (
        <Sidebar route={route} />
      )}
      {/* The task panel slides in over the content below its top bar, rather than squeezing it. */}
      <div className="relative min-w-0 flex-1">
        <div className="h-full min-w-0">
          {route.name === "profile" && <ProfileBoard key={route.profile} profile={route.profile} />}
          {route.name === "board" && <Board projectId={route.projectId} />}
          {route.name === "group" && <GroupBoard hostId={route.hostId} group={route.group} />}
          {route.name === "task" && <TaskView taskId={route.taskId} />}
          {route.name === "assistant" && <AssistantPage key={route.profile} profile={route.profile} />}
          {route.name === "docs" && <DocsPage key={route.profile} route={route} />}
          {route.name === "projectSettings" && <ProjectSettings key={route.projectId} projectId={route.projectId} tab={route.tab} />}
          {route.name === "settings" && <Settings tab={route.tab} />}
          {route.name === "analytics" && <Analytics profile={route.profile ?? null} />}
          {route.name === "guide" && <Guide page={route.page} />}
          {route.name === "host" && <HostPage key={route.hostId} hostId={route.hostId} />}
        </div>
        {panel && hasPanel(route) && <TaskPanel panel={panel} />}
      </div>
      {panel?.compare === true && hasPanel(route) && (
        <Suspense fallback={null}>
          <CompareView taskId={panel.taskId} />
        </Suspense>
      )}
      {modal !== null && <TaskModal key={modal} taskId={modal} />}
      <UnhandledErrors />
    </div>
  )
}
