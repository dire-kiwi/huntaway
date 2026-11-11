import { useEffect, useLayoutEffect } from "react"
import { DEFAULT_TINT, previewTint } from "../../../theme"
import { Button } from "../../ui"

/**
 * A profile's tint (see theme.ts): `value` is `#rrggbb` or null for the stock theme. The board shows the colour picked
 * here while the form is open, then the active profile's again.
 */
export function TintField({ value, onChange, picked }: { value: string | null; onChange: (v: string | null) => void; picked: boolean }) {
  useEffect(() => {
    if (picked) previewTint(value)
  }, [picked, value])
  // In the commit that takes the form away, rather than after it: a save closes it outside the click (once its request
  // is answered), when React would run a passive cleanup later.
  useLayoutEffect(() => () => previewTint(undefined), [])
  return (
    <div className="space-y-1.5">
      <span className="block text-xs font-medium text-muted">Theme tint</span>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-[12.5px] text-fg">
          <input
            type="color"
            aria-label="Tint colour"
            value={value ?? DEFAULT_TINT}
            onChange={(e) => onChange(e.target.value)}
            className="h-7 w-10 cursor-pointer rounded-md border border-line bg-panel p-0.5"
          />
          <span className="font-mono text-[12px]">{value ?? "Stock theme"}</span>
        </label>
        <Button size="sm" disabled={!value} onClick={() => onChange(null)}>
          Reset to stock theme
        </Button>
      </div>
      <span className="block text-xs text-faint">The board takes on this colour's hue while this profile is the one in the sidebar, in every browser.</span>
    </div>
  )
}
