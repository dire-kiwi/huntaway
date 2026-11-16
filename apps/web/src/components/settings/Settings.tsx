import { clsx } from "clsx"
import { Archive, Bell, Blocks, Bot, FlaskConical, KeyRound, Keyboard, Network, Puzzle, Server, Users, Wifi } from "lucide-react"
import { Fragment, type ReactNode } from "react"
import { navigate } from "../../state/route"
import { canRunAgents } from "@huntaway/client"
import { profileNames } from "../boardHelpers"
import { useBoard } from "../../state/board"
import { MenuButton } from "../ui"
import { NotificationsPanel } from "../layout/Notifications"
import { GlobalAgentToolsPanel } from "./agentTools/GlobalAgentToolsPanel"
import { AssistantsPanel } from "./Assistants"
import { ArchivedProjectsPanel } from "./ArchivedProjects"
import { ClaudeConfigsPanel, configHosts } from "./ClaudeConfigs"
import { ExperimentsPanel } from "./Experiments"
import { HostsPanel } from "./Hosts"
import { ProfilesPanel } from "./hosts/ProfilesPanel"
import { NetworkPanel } from "./Network"
import { PluginsPanel } from "./Plugins"
import { ServerPanel } from "./Server"
import { ShortcutsPanel } from "./Shortcuts"

type SettingsTab =
  | "hosts"
  | "configs"
  | "profiles"
  | "assistant"
  | "tools"
  | "plugins"
  | "notifications"
  | "shortcuts"
  | "archived"
  | "server"
  | "network"
  | "experiments"

interface TabDef {
  id: SettingsTab
  label: string
  icon: ReactNode
  panel: () => ReactNode
}

/**
 * The settings' sections in their groups down the side, as the project settings have theirs (HA-406, HE-39): the board
 * (its hosts, its profiles, the projects put away), what its agents run with, this browser, and this server. Their
 * labels are the panels' headings, which the rest of the UI names as `Settings → <label>`. Each panel is its area's
 * (M6, HE-7; Hosts is M7's) and has its own heading (`PanelHeading`), with the condition that shows it below.
 */
const TAB_GROUPS: ReadonlyArray<ReadonlyArray<TabDef>> = [
  [
    { id: "hosts", label: "Hosts", icon: <Network size={14} />, panel: () => <HostsPanel /> },
    { id: "profiles", label: "Profiles", icon: <Users size={14} />, panel: () => <ProfilesPanel /> },
    { id: "archived", label: "Archived projects", icon: <Archive size={14} />, panel: () => <ArchivedProjectsPanel /> },
  ],
  [
    { id: "configs", label: "Agent configs", icon: <KeyRound size={14} />, panel: () => <ClaudeConfigsPanel /> },
    { id: "tools", label: "Skills and MCP", icon: <Puzzle size={14} />, panel: () => <GlobalAgentToolsPanel /> },
    // HE-34
    { id: "plugins", label: "Plugins", icon: <Blocks size={14} />, panel: () => <PluginsPanel /> },
    { id: "assistant", label: "Assistant", icon: <Bot size={14} />, panel: () => <AssistantsPanel /> },
  ],
  [
    { id: "notifications", label: "Notifications", icon: <Bell size={14} />, panel: () => <NotificationsPanel /> },
    { id: "shortcuts", label: "Keyboard shortcuts", icon: <Keyboard size={14} />, panel: () => <ShortcutsPanel /> },
  ],
  [
    { id: "server", label: "Server", icon: <Server size={14} />, panel: () => <ServerPanel /> },
    { id: "network", label: "Network access", icon: <Wifi size={14} />, panel: () => <NetworkPanel /> },
    { id: "experiments", label: "Experiments", icon: <FlaskConical size={14} />, panel: () => <ExperimentsPanel /> },
  ],
]

export function Settings({ tab }: { tab?: string | undefined }) {
  const hosts = useBoard((s) => s.hosts)
  const profiles = useBoard((s) => s.profiles)
  // The panels that show nothing without a host (or profile) for them have no tab then.
  const shown: Record<SettingsTab, boolean> = {
    hosts: true,
    configs: configHosts(hosts).length > 0,
    profiles: true,
    assistant: profileNames(profiles).length > 0,
    tools: hosts.some((h) => canRunAgents(h)),
    plugins: true,
    notifications: true,
    shortcuts: true,
    archived: profiles.length > 0,
    server: true,
    network: true,
    experiments: true,
  }
  // A group with none of its tabs shown has no line of its own.
  const groups = TAB_GROUPS.map((group) => group.filter((t) => shown[t.id])).filter((group) => group.length > 0)
  const tabs = groups.flat()
  const current = tabs.find((t) => t.id === tab) ?? tabs[0]
  if (!current) return null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="drag flex h-12 shrink-0 items-center gap-3 border-b border-line px-5 narrow:px-3">
        <MenuButton />
        <h1 className="text-[14px] font-semibold">Settings</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* The tabs and the open one are together in the middle, the tabs staying put as it scrolls. */}
        <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6 narrow:gap-4 narrow:p-4 md:flex-row md:gap-10">
          <nav
            role="tablist"
            aria-label="Settings"
            aria-orientation="vertical"
            className="flex shrink-0 gap-0.5 overflow-x-auto md:sticky md:top-6 md:w-48 md:flex-col md:self-start"
          >
            {groups.map((group, i) => (
              <Fragment key={group[0]?.id}>
                {/* A line between the groups: across the side list, down the row of tabs when they're along the top. */}
                {i > 0 && <span aria-hidden className="mx-1.5 w-px shrink-0 self-stretch bg-line md:mx-2.5 md:my-2 md:h-px md:w-auto" />}
                {group.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    id={`settings-tab-${t.id}`}
                    aria-selected={t === current}
                    aria-controls="settings-tab-panel"
                    onClick={() => navigate({ name: "settings", tab: t.id }, true)}
                    className={clsx(
                      "flex shrink-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px]",
                      t === current ? "bg-raised text-fg" : "text-muted hover:bg-white/[0.04] hover:text-fg",
                    )}
                  >
                    <span className={t === current ? "text-accent" : "text-faint"}>{t.icon}</span>
                    <span className="flex-1 whitespace-nowrap">{t.label}</span>
                  </button>
                ))}
              </Fragment>
            ))}
          </nav>
          <div id="settings-tab-panel" role="tabpanel" aria-labelledby={`settings-tab-${current.id}`} className="min-w-0 flex-1">
            {current.panel()}
          </div>
        </div>
      </div>
    </div>
  )
}
