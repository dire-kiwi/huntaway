import { RegistryContext } from "@effect/atom-react"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import { setUpViewport } from "./narrow"
import { startAuth } from "./state/auth"
import { registry } from "./state/registry"
import { setUpTint } from "./theme"

// The token: `?token=` (taken off the URL), else the one kept in this browser, else a board's open token (state/auth.ts).
startAuth()
setUpViewport()
setUpTint()

const root = document.getElementById("root")
if (root)
  createRoot(root).render(
    <StrictMode>
      <RegistryContext.Provider value={registry}>
        <App />
      </RegistryContext.Provider>
    </StrictMode>,
  )
