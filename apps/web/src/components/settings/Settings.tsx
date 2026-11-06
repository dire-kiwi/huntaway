import { useEffect, useState } from "react";
import { api, getToken, type HostInfo } from "../../api";
import { useStore } from "../../store";
import { GlobalAgentToolsPanel } from "./AgentTools";
import { ArchivedProjectsPanel } from "./ArchivedProjects";
import { ClaudeConfigsPanel } from "./ClaudeConfigs";
import { HostsPanel, ProfilesPanel } from "./Hosts";
import { NotificationsPanel } from "../layout/Notifications";
import { DevicesPanel } from "./Devices";
import { ServerPanel } from "./Server";
import { Button, Input, MenuButton } from "../ui";

export function Settings() {
  const localHostId = useStore((s) => s.localHostId);
  const [info, setInfo] = useState<HostInfo | null>(null);
  const [showToken, setShowToken] = useState(false);
  useEffect(() => {
    if (localHostId)
      api
        .info(localHostId)
        .then(setInfo)
        .catch(() => {});
  }, [localHostId]);
  const port = window.location.port || (window.location.protocol === "https:" ? "443" : "80");
  const networkUrl = info ? `http://${info.hostname}:${port}/?token=${getToken()}` : "";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="drag flex h-12 shrink-0 items-center gap-3 border-b border-line px-5 narrow:px-3">
        <MenuButton />
        <h1 className="text-[14px] font-semibold">Settings</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-8 p-6 narrow:p-4">
          <HostsPanel />

          <ClaudeConfigsPanel />

          <ProfilesPanel />

          <GlobalAgentToolsPanel />

          <NotificationsPanel />

          <ArchivedProjectsPanel />

          <ServerPanel />

          <section>
            <h2 className="mb-3 text-[13px] font-semibold">Network access</h2>
            <div className="space-y-3 rounded-xl border border-line p-4 text-[12.5px] text-muted">
              <p>
                The server listens on all interfaces by default (<code>--host</code> / <code>IA_HOST</code> to change). Open this URL from another machine. The
                token in it grants full control, including running agents, so only share it over a trusted network such as a VPN or Tailscale.
              </p>
              <div className="flex items-center gap-2">
                <Input readOnly className="font-mono text-[11.5px]" value={showToken ? networkUrl : networkUrl.replace(/token=.*/, "token=••••••••")} />
                <Button size="sm" onClick={() => setShowToken(!showToken)}>
                  {showToken ? "Hide" : "Reveal"}
                </Button>
                <Button size="sm" onClick={() => navigator.clipboard?.writeText(networkUrl)}>
                  Copy
                </Button>
              </div>
              <DevicesPanel />
              {info && (
                <div className="text-faint">
                  Data directory: <span className="font-mono">{info.data_dir}</span> · v{info.version}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
