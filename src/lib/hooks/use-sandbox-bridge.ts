"use client";

import { useEffect, useRef } from "react";
import useSWR from "swr";
import { useActiveSandbox } from "@/stores/workspace-store";
import { useNotificationStore } from "@/stores/notification-store";
import { useDesktopStore } from "@/stores/desktop-store";
import {
  sandboxServiceFetcher,
  sandboxServiceOnErrorRetry,
} from "@/lib/hooks/use-sandbox-service-client";

interface BridgeNotification {
  id: number;
  appName: string;
  replacesId: number;
  icon: string | null;
  summary: string;
  body: string;
  actions: string[];
  expires: number;
  timestamp: number;
  urgency: "low" | "normal" | "critical";
  category: string | null;
  transient: boolean;
  resident: boolean;
  desktopEntry: string | null;
}

interface BridgeNotificationsResponse {
  notifications: BridgeNotification[];
}



/**
 * Polls the sandbox bridge for notifications sent via `notify-send` or GLib
 * inside the sandbox. New notifications are fed into the existing
 * notification store so they appear as toast popups and in the notification
 * center, identical to Xpra-forwarded notifications.
 *
 * Uses SWR with `refreshInterval` for efficient polling -- only fetches
 * notifications newer than the last seen timestamp.
 */
export function useDbusNotifications() {
  const { activeWorkspaceId, sandbox } = useActiveSandbox();
  // Lazy-init the "since" timestamp once, off the render path: calling Date.now()
  // directly in useRef(...) is an impure call during render
  // (react-hooks/purity). null until the first effect run stamps it.
  const sinceRef = useRef<number | null>(null);
  const addNotification = useNotificationStore((s) => s.addNotification);

  // Remote services backend removed in favor of the in-page portabox sandbox.
  // There is no longer a services domain, so this bridge is disabled (no-op):
  // the SWR key is always null and nothing is fetched. (When a key is wired back
  // in, build it inside the fetcher/effect so sinceRef is not read during render
  // -- react-hooks/refs.)
  void sandbox;

  const { data } = useSWR<BridgeNotificationsResponse>(
    null,
    sandboxServiceFetcher,
    {
      refreshInterval: 1000,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      dedupingInterval: 500,
      onErrorRetry: sandboxServiceOnErrorRetry,
    },
  );

  useEffect(() => {
    // Stamp the initial "since" off the render path (lazy-init).
    if (sinceRef.current === null) sinceRef.current = Date.now();
    if (!data?.notifications?.length) return;

    for (const notif of data.notifications) {
      if (notif.timestamp > (sinceRef.current ?? 0)) {
        sinceRef.current = notif.timestamp;
      }

      addNotification({
        id: notif.id,
        replacesId: notif.replacesId,
        appName: notif.appName,
        summary: notif.summary,
        body: notif.body,
        icon: notif.icon,
        actions: notif.actions,
        expires: notif.expires,
        urgency: notif.urgency ?? "normal",
        category: notif.category ?? null,
        transient: notif.transient ?? false,
        workspaceId: activeWorkspaceId,
      });
    }
  }, [data, addNotification, activeWorkspaceId]);
}

// ---------------------------------------------------------------------------
// Desktop entry monitor
// ---------------------------------------------------------------------------

interface AppsGenerationResponse {
  generation: number;
}

/**
 * Polls the bridge for .desktop file changes (via inotify in the Python
 * daemon). When the generation counter bumps, re-fetches the full desktop
 * entry list so newly installed apps appear on the desktop and in menus.
 */
export function useDesktopEntryMonitor() {
  const { sandbox } = useActiveSandbox();
  const generationRef = useRef<number | null>(null);
  const fetchRemoteApps = useDesktopStore((s) => s.fetchRemoteApps);

  // Remote services backend removed in favor of the in-page portabox sandbox.
  // No services domain anymore, so the desktop-entry monitor is disabled (no-op).
  void sandbox;
  const servicesUrl: string | null = null;

  const { data } = useSWR<AppsGenerationResponse>(
    servicesUrl ? `${servicesUrl}/bridge/apps-generation` : null,
    sandboxServiceFetcher,
    {
      refreshInterval: 3000,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      dedupingInterval: 2000,
      onErrorRetry: sandboxServiceOnErrorRetry,
    },
  );

  useEffect(() => {
    // Disabled: no remote services domain to fetch desktop entries from.
    if (data == null) return;
    const gen = data.generation;

    if (generationRef.current === null) {
      // First load -- just record the baseline
      generationRef.current = gen;
      return;
    }

    if (gen !== generationRef.current) {
      generationRef.current = gen;
    }
  }, [data, fetchRemoteApps]);
}
