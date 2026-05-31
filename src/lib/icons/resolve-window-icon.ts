import { useDesktopStore } from "@/stores/desktop-store";

/**
 * Resolve the best icon URL for a given appId.
 *
 * Priority:
 * 1. DesktopEntry.icon (Dusk SVGs for builtins, sandbox-proxied Linux icons for X11 apps)
 * 2. null (caller renders a fallback)
 *
 * This reads directly from store state (not hooks) so it can be called
 * from either React components or plain functions.
 */
export function resolveWindowIcon(appId: string): string | null {
  const apps = useDesktopStore.getState().apps;
  const entry = apps.find((a) => a.id === appId || a.component === appId);
  return entry?.icon ?? null;
}

/**
 * React hook version -- subscribes to the desktop store so the component
 * re-renders when the app list / icons change.
 */
export function useResolvedIcon(appId: string): string | null {
  const apps = useDesktopStore((s) => s.apps);
  const entry = apps.find((a) => a.id === appId || a.component === appId);
  return entry?.icon ?? null;
}
