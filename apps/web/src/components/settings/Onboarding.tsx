import { defaultAgentHost } from "../boardHelpers"
import { useBoard } from "../../state/board"
import { HostsPanel } from "./Hosts"
import { ProfileForm } from "./hosts/ProfileForm"

export function Onboarding() {
  const host = useBoard((s) => defaultAgentHost(s.hosts))
  if (!host) {
    // A board-only hub: agents need a host that can run them.
    return (
      <div className="flex h-full items-center justify-center overflow-y-auto p-6">
        <div className="w-full max-w-2xl rounded-2xl border border-line bg-panel p-6">
          <h1 className="mb-1 text-[16px] font-semibold">Welcome to Huntaway</h1>
          <p className="mb-5 text-[13px] text-muted">
            This board doesn&apos;t run agents itself. Connect a machine that can, for example your workstation over SSH, then create a profile on it.
          </p>
          <HostsPanel />
        </div>
      </div>
    )
  }
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-line bg-panel p-6">
        <h1 className="mb-1 text-[16px] font-semibold">Welcome to Huntaway</h1>
        <p className="mb-5 text-[13px] text-muted">
          Create a profile to get started. Its agents use a Claude config directory, e.g. <code>~/.claude-work</code> or <code>~/.claude-personal</code>; more
          (including Codex ones) can be added under Settings → Agent configs.
        </p>
        <ProfileForm hostId={host} onDone={() => {}} />
      </div>
    </div>
  )
}
