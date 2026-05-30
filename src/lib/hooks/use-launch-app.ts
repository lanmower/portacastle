import { useCallback } from "react";
import { useWindowStore } from "@/stores/window-store";
import { useActiveSandbox } from "@/stores/workspace-store";
import { launchXApp } from "@/lib/x-launch";
import { APP_COMPONENTS } from "@/components/apps/app-registry";
import type { DesktopEntry } from "@/types/desktop-entry";

/**
 * Resolve the canonical app identifier for a desktop entry.
 * Prefer `component` (builtin React app), then `exec` (X11 command), then `id`.
 */
export function getAppId(entry: DesktopEntry): string {
  return entry.component || entry.exec || entry.id;
}

/** Default window dimensions keyed by appId. */
const APP_WINDOW_DEFAULTS: Record<string, { width: number; height: number }> = {
  terminal: { width: 720, height: 480 },
};

const DEFAULT_WINDOW_SIZE = { width: 800, height: 600 };

/**
 * Hook that returns a stable callback to launch any desktop entry.
 *
 * Builtin apps (those registered in APP_COMPONENTS) open a React window via
 * the window store. Everything else is an X11 app launched in-page against the
 * Xvfb under blink (replaces the removed Xpra/remote-VM launch path).
 */
export function useLaunchApp() {
  const openWindow = useWindowStore((s) => s.openWindow);
  const { activeWorkspaceId } = useActiveSandbox();

  const launch = useCallback(
    (entry: DesktopEntry) => {
      const appId = getAppId(entry);

      if (appId in APP_COMPONENTS) {
        const { width, height } =
          APP_WINDOW_DEFAULTS[appId] ?? DEFAULT_WINDOW_SIZE;
        openWindow({ title: entry.name, appId, width, height });
      } else if (activeWorkspaceId) {
        // X11 app: open a live X window (XWindowCanvas blits the persistent
        // Xvfb framebuffer) AND launch the app as a client against the in-page
        // Xvfb. The exec command (or app id) is the binary name. The window's
        // appId carries the command so WindowRenderer mounts the X canvas.
        const command = entry.exec || appId;
        openWindow({
          title: entry.name,
          appId: `x11:${command}`,
          width: DEFAULT_WINDOW_SIZE.width,
          height: DEFAULT_WINDOW_SIZE.height,
        });
        void launchXApp(activeWorkspaceId, command).catch(() => {});
      }
    },
    [openWindow, activeWorkspaceId],
  );

  return launch;
}
