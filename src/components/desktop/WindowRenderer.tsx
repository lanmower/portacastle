"use client";

import { useWindowStore } from "@/stores/window-store";
import { useIsMobile } from "@/lib/hooks/use-is-mobile";
import { Window } from "@/components/window/Window";
import { MobileWindowStack } from "@/components/window/MobileWindowStack";
import { XWindowCanvas } from "@/components/apps/x-window/XWindowCanvas";
import { APP_COMPONENTS } from "@/components/apps/app-registry";

export function WindowRenderer() {
  const windowsByWorkspace = useWindowStore((s) => s.windowsByWorkspace);
  const activeWorkspaceId = useWindowStore((s) => s.activeWorkspaceId);
  const windows = activeWorkspaceId
    ? windowsByWorkspace[activeWorkspaceId] || []
    : [];
  const isMobile = useIsMobile();

  if (isMobile) {
    return <MobileWindowStack windows={windows} />;
  }

  return (
    <>
      {windows.map((win) => {
        // Live in-page X11 windows use appId format "x11:<command>" -- blit the
        // persistent Xvfb framebuffer to a canvas (no remote VM, no xpra).
        if (win.appId.startsWith("x11:") && activeWorkspaceId) {
          return (
            <Window key={win.id} window={win}>
              <XWindowCanvas workspaceId={activeWorkspaceId} />
            </Window>
          );
        }

        // Builtin React components
        const AppComponent = APP_COMPONENTS[win.appId];
        if (AppComponent) {
          return (
            <Window key={win.id} window={win}>
              <AppComponent meta={win.meta} />
            </Window>
          );
        }

        // Unknown appId with no component -- shouldn't happen: launches emit
        // either an "x11:" appId (handled above) or a registered component id.
        return null;
      })}
    </>
  );
}
