"use client";

import { useEffect, useRef } from "react";
import { useTheme } from "next-themes";
import { useActiveSandbox } from "@/stores/workspace-store";

/**
 * Syncs the resolved theme (light/dark) to the sandbox's GTK/GNOME settings
 * so X11 apps render with the correct color scheme.
 *
 * Two-pronged approach:
 * 1. Writes GTK settings.ini files + gsettings for GTK3 apps and env vars
 * 2. Posts color-scheme to the sandbox bridge, which exposes it via the
 *    org.freedesktop.portal.Settings interface for GTK4/libadwaita apps
 */
export function useSyncSandboxTheme() {
  const { resolvedTheme } = useTheme();
  const { sandbox } = useActiveSandbox();
  const lastSyncedRef = useRef<string | null>(null);

  useEffect(() => {
    // Remote services backend removed in favor of the in-page portabox sandbox.
    // There is no remote endpoint to push GTK/portal theme settings to, so this
    // hook is now a no-op.
    void resolvedTheme;
    void sandbox;
    void lastSyncedRef;
    return;
  }, [resolvedTheme, sandbox]);
}
