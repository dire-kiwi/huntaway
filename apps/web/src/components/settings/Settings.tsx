import { clsx } from "clsx"
import { Archive, Bell, Bot, KeyRound, Keyboard, Network, Puzzle, Server, Users, Wifi } from "lucide-react"
import type { ReactNode } from "react"
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
import { HostsPanel } from "./Hosts"
import { ProfilesPanel } from "./hosts/ProfilesPanel"
import { NetworkPanel } from "./Network"
import { ServerPanel } from "./Server"
import { ShortcutsPanel } from "./Shortcuts"

type SettingsTab = "hosts" | "configs" | "profiles" | "assistant" | "tools" | "notifications" | "shortcuts" | "archived" | "server" | "network"

/**
 * The settings' sections, in their order down the side (HA-406), as the project settings have theirs. Their labels are
 * the panels' headings, which the rest of the UI names as `Settings → <label>`. Each panel is its area's (M6, HE-7;
 * Hosts is M7's), with the condition that shows it.
 */
const SETTINGS_TABS: { id: SettingsTab; label: string; icon: ReactNode; panel: () => ReactNode }[] = [
  { id: "hosts", label: "Hosts", icon: <Network size={14} />, panel: () => <HostsPanel /> },
  { id: "configs", label: "Agent configs", icon: <KeyRound size={14} />, panel: () => <ClaudeConfigsPanel /> },
  { id: "profiles", label: "Profiles", icon: <Users size={14} />, panel: () => <ProfilesPanel /> },
  { id: "assistant", label: "Assistant", icon: <Bot size={14} />, panel: () => <AssistantsPanel /> },
  { id: "tools", label: "Skills and MCP", icon: <Puzzle size={14} />, panel: () => <GlobalAgentToolsPanel /> },
  { id: "notifications", label: "Notifications", icon: <Bell size={14} />, panel: () => <NotificationsPanel /> },
  { id: "shortcuts", label: "Keyboard shortcuts", icon: <Keyboard size={14} />, panel: () => <ShortcutsPanel /> },
  { id: "archived", label: "Archived projects", icon: <Archive size={14} />, panel: () => <ArchivedProjectsPanel /> },
  { id: "server", label: "Server", icon: <Server size={14} />, panel: () => <ServerPanel /> },
  { id: "network", label: "Network access", icon: <Wifi size={14} />, panel: () => <NetworkPanel /> },
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
    notifications: true,
    shortcuts: true,
    archived: profiles.length > 0,
    server: true,
    network: true,
  }
  const tabs = SETTINGS_TABS.filter((t) => shown[t.id])
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
            {tabs.map((t) => (
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
          </nav>
          <div id="settings-tab-panel" role="tabpanel" aria-labelledby={`settings-tab-${current.id}`} className="min-w-0 flex-1 space-y-8">
            {current.panel()}
          </div>
        </div>
      </div>
    </div>
  )
}
