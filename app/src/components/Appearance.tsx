import clsx from "clsx";
import { Moon, MonitorCog, Sun } from "lucide-react";
import type { ReactNode } from "react";
import { saveTheme, THEMES, useTheme, type Theme } from "../theme";
import { segment, SEGMENTED } from "./ui";

const ICONS: Record<Theme, ReactNode> = { system: <MonitorCog size={13} />, light: <Sun size={13} />, dark: <Moon size={13} /> };

/** Settings → Appearance: light or dark, kept in this browser (see theme.ts). */
export function AppearancePanel() {
  const theme = useTheme();
  return (
    <section>
      <h2 className="mb-3 text-[13px] font-semibold">Appearance</h2>
      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-line bg-panel p-4 text-[12.5px] text-muted">
        <p className="min-w-0 flex-1">Light or dark, for this browser. System follows the device's setting as it changes.</p>
        <div className={clsx(SEGMENTED, "shrink-0")} role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={theme === t.id}
              title={t.description}
              onClick={() => saveTheme(t.id)}
              className={clsx(segment(theme === t.id), "h-7 px-3 text-[12px]")}
            >
              {ICONS[t.id]} {t.label}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
