import clsx from "clsx";
import { useEffect } from "react";
import { activeProfile, loadActiveProfile } from "./activeProfile";
import { setUnauthorizedHandler } from "./api";
import { Analytics } from "./components/Analytics";
import { ProjectApprovals } from "./components/Approvals";
import { Board, GroupBoard, ProfileBoard, SubprojectBoard } from "./components/Board";
import { HostPage } from "./components/HostPage";
import { Onboarding, ProjectSettings, Settings, TokenScreen } from "./components/Settings";
import { Sidebar } from "./components/Sidebar";
import { TaskPanel, TaskView } from "./components/TaskView";
import { useDrawer, useNarrow } from "./narrow";
import { startNotifications } from "./notifier";
import { boardTaskUrl, groupTaskUrl, hasPanel, navigate, profileTaskUrl, subprojectTaskUrl, usePanel, useRoute } from "./router";
import { connectEvents, isGroupTask, profileNames, useProfileName, useStore } from "./store";
import { startToolKeepalive } from "./terminalTools";

export function App() {
  const authed = useStore((s) => s.authed);
  const profiles = useStore((s) => s.profiles);
  const loaded = useStore((s) => s.loaded);
  const route = useRoute();
  const panel = usePanel();
  const routeTask = useStore((s) => (route.name === "task" ? s.tasks[route.taskId] : undefined));
  const narrow = useNarrow();
  const drawer = useDrawer();

  useEffect(() => {
    setUnauthorizedHandler(() => useStore.getState().setAuthed(false));
    connectEvents();
    startToolKeepalive();
    startNotifications();
  }, []);

  // Home is the board of the profile picked last (or the first one), which has every one of its tasks.
  const homeProfile = activeProfile(profileNames(profiles), loadActiveProfile());
  useEffect(() => {
    if (route.name === "home" && homeProfile && loaded) navigate({ name: "profile", profile: homeProfile }, true);
  }, [route.name, homeProfile, loaded]);

  // A subproject's task opens beside the subproject's board.
  const routeSubproject = useStore((s) => {
    const p = routeTask?.kind === "task" && routeTask.parent_id ? s.tasks[routeTask.parent_id] : undefined;
    return p?.subproject ? p : undefined;
  });

  // A group task opens beside its group's board, which stays while the group has group tasks.
  const routeGroup = routeTask && isGroupTask(routeTask) ? routeTask.group_name! : undefined;
  // Any other task in no project (a scratch task) beside its profile's board.
  const routeProfile = useProfileName(routeTask);

  // Tasks open beside their board, so a task's own page moves there once its project is known.
  useEffect(() => {
    if (routeTask && routeGroup) return navigate(groupTaskUrl(routeTask.host_id, routeGroup, routeTask.id), true);
    if (routeTask?.kind === "task" && !routeTask.project_id && routeProfile) return navigate(profileTaskUrl(routeProfile, routeTask.id), true);
    if (!routeTask?.project_id) return;
    if (routeSubproject) navigate(subprojectTaskUrl(routeSubproject.id, routeTask.id), true);
    else navigate(boardTaskUrl(routeTask.project_id, routeTask.id), true);
  }, [routeTask?.project_id, routeTask?.id, routeTask?.host_id, routeTask?.kind, routeSubproject, routeGroup, routeProfile]);

  // The narrow layout's drawer closes once it's taken you somewhere, and when the window gets wide enough for the sidebar.
  const page = JSON.stringify(route);
  useEffect(() => useDrawer.getState().setOpen(false), [page, panel?.taskId, narrow]);
  useEffect(() => {
    if (!drawer.open) return;
    const onKey = (e: KeyboardEvent) => {
      // Not while a dialog or menu of its own is open.
      if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector("[data-modal]")) drawer.setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  if (authed === false) return <TokenScreen />;
  if (authed === null) return null;
  if (profiles.length === 0) return loaded ? <Onboarding /> : null;

  return (
    <div className="relative flex h-full">
      {narrow ? (
        // A drawer over the page, which stays mounted closed so its menus and dialogs, and its scroll, stay as they were.
        <>
          {drawer.open && <div className="absolute inset-0 z-40 bg-black/60" onClick={() => drawer.setOpen(false)} />}
          <div
            inert={!drawer.open}
            className={clsx(
              "absolute inset-y-0 left-0 z-40 w-[min(85%,300px)] shadow-2xl shadow-black/50 transition-[translate,visibility] duration-200",
              !drawer.open && "invisible -translate-x-full",
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
          {route.name === "subproject" && <SubprojectBoard taskId={route.taskId} />}
          {route.name === "projectSettings" && <ProjectSettings key={route.projectId} projectId={route.projectId} tab={route.tab} />}
          {route.name === "settings" && <Settings />}
          {route.name === "analytics" && <Analytics />}
          {route.name === "host" && <HostPage key={route.hostId} hostId={route.hostId} />}
        </div>
        {panel && hasPanel(route) && <TaskPanel panel={panel} />}
      </div>
      <ProjectApprovals />
    </div>
  );
}
