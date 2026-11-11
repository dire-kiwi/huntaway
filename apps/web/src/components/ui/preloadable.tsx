import { lazy, useState, type ComponentType } from "react"

/**
 * A component loaded with its own chunk, as `lazy` loads one, but rendered at once when its module has loaded already
 * (`preload` loads it ahead). A lazy component suspends the first time it's shown even then, and React holds back what
 * comes after a Suspense fallback for 300ms: a tab like Changes took that much longer to show on its first open.
 */
export function preloadable<P extends object>(load: () => Promise<ComponentType<P>>) {
  let loaded: ComponentType<P> | null = null
  let loading: Promise<ComponentType<P>> | null = null
  const preload = () =>
    (loading ??= load().then(
      (c) => (loaded = c),
      (e) => {
        loading = null // tried again next time
        throw e
      },
    ))
  const Lazy = lazy(() => preload().then((c) => ({ default: c })))
  function Preloadable(props: P) {
    // Picked once: switching from Lazy to the loaded component would mount it again.
    const [C] = useState<ComponentType<P>>(() => loaded ?? Lazy)
    return <C {...props} />
  }
  return Object.assign(Preloadable, { preload: () => void preload().catch(() => {}) })
}
