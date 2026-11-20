// The Chrome or Chromium this machine has, for the browser's tests (`$CHROMIUM`, else /usr/bin/chromium as
// scripts/ui-check.mjs looks for it); null where there's none, and those tests are skipped. Never a download.

import { existsSync } from "node:fs"

const candidates = [process.env["CHROMIUM"], "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]

export const systemChrome: string | null = candidates.find((p): p is string => p !== undefined && p !== "" && existsSync(p)) ?? null
