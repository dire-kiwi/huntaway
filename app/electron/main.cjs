// HA-263 moved the desktop app to apps/web. The macOS app that an older scripts/install.sh made loads this file: it goes
// on to the one in apps/web until install.sh runs again and points it there (see scripts/legacy-update.sh).
require("../../apps/web/electron/main.cjs");
