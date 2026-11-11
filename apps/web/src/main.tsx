import { RegistryContext } from "@effect/atom-react"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import { startNotifications } from "./components/layout/notifier"
import { startPush } from "./components/layout/push"
import { setUpViewport } from "./narrow"
import { startAuth } from "./state/auth"
import { registry } from "./state/registry"
import { setUpTint } from "./theme"

// The token: `?token=` (taken off the URL), else the one kept in this browser, else a board's open token (state/auth.ts).
startAuth()
setUpViewport()
setUpTint()
// 6.8: this browser's notifications and the count in the title, and Web Push's service worker.
startNotifications()
startPush()

const root = document.getElementById("root")
if (root)
  createRoot(root).render(
    <StrictMode>
      <RegistryContext.Provider value={registry}>
        <App />
      </RegistryContext.Provider>
    </StrictMode>,
  )
