import { clsx } from "clsx"
import { Network } from "lucide-react"
import type { ReactNode } from "react"
import { navigate } from "../../state/route"
import { MenuButton } from "../ui"
import { HostsPanel } from "./Hosts"

type SettingsTab = "hosts"

/**
 * The settings' sections, in their order down the side (HA-406), as the project settings have theirs. Their labels are
 * the panels' headings, which the rest of the UI names as `Settings → <label>`. Only Hosts is on this server so far: the
 * others (Agent configs, Profiles, Assistant, Skills and MCP, Notifications, Keyboard shortcuts, Archived projects,
 * Server, Network access) come over with the rest of settings/ (docs/plan/13-milestones.md, 6.12), as siblings here,
 * each with the condition that shows it.
 */
const SETTINGS_TABS: { id: SettingsTab; label: string; icon: ReactNode; panel: () => ReactNode }[] = [
  { id: "hosts", label: "Hosts", icon: <Network size={14} />, panel: () => <HostsPanel /> },
]

export function Settings({ tab }: { tab?: string | undefined }) {
  // The panels that show nothing without a host (or profile) for them have no tab then.
  const shown: Record<SettingsTab, boolean> = { hosts: true }
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
