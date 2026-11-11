import { KeyRound } from "lucide-react"
import { useState } from "react"
import { signIn } from "../../state/auth"
import { Button, Input } from "../ui"

export function TokenScreen() {
  const [t, setT] = useState("")
  return (
    <div className="flex h-full items-center justify-center p-6">
      <form
        className="w-full max-w-sm space-y-4 rounded-2xl border border-line bg-panel p-6"
        onSubmit={(e) => {
          e.preventDefault()
          signIn(t.trim())
        }}
      >
        <div className="flex items-center gap-2 text-[15px] font-semibold">
          <KeyRound size={16} /> Access token required
        </div>
        <p className="text-[12.5px] text-muted">
          Run <code className="text-fg">huntaway token</code> on the server, or open the link it prints at startup.
        </p>
        <Input autoFocus type="password" value={t} onChange={(e) => setT(e.target.value)} placeholder="token" />
        <Button variant="primary" className="w-full" disabled={!t.trim()}>
          Connect
        </Button>
      </form>
    </div>
  )
}
