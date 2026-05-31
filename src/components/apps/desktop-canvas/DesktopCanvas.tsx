"use client";

import { useEffect, useRef, useState } from "react";
import { useActiveSandbox } from "@/stores/workspace-store";
import { useClientSandboxStore } from "@/stores/client-sandbox-store";
import { NoWorkspacePlaceholder } from "@/components/apps/no-workspace-placeholder";

/**
 * In-page desktop view.
 *
 * Replaces the Xpra-over-WebSocket multi-window connector (which needed a
 * remote `sandbox.domains.xpra` endpoint) with a single <canvas> attached to
 * the in-page sandbox's framebuffer via `sandbox.attachDisplay(canvas)`. The
 * portabox display loop blits the guest's RGBA framebuffer zero-copy and
 * forwards canvas keyboard/mouse into the guest input device.
 *
 * Pixel content requires an in-guest display producer (an fbdev X server, or
 * any program drawing to the registered framebuffer) -- see the
 * guest-display-producer work. Until a producer is running, the canvas shows a
 * waiting state; attachDisplay is harmless and starts painting as soon as the
 * guest registers a framebuffer.
 */
export function DesktopCanvas() {
  const { activeWorkspaceId } = useActiveSandbox();
  const ensureSandbox = useClientSandboxStore((s) => s.ensureSandbox);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<"idle" | "booting" | "attached" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !activeWorkspaceId) return;

    let disposed = false;
    let display: { stop: () => void } | null = null;

    (async () => {
      // setStatus moved inside the async body so it is not called synchronously
      // in the effect (react-hooks/set-state-in-effect); still runs before await.
      setStatus("booting");
      try {
        const sandbox = await ensureSandbox(activeWorkspaceId);
        if (disposed) return;
        const d = await sandbox.attachDisplay(canvas, { fpsCap: 60 });
        display = d;
        if (disposed) {
          d.stop();
          return;
        }
        setStatus("attached");
        setMessage(null);
      } catch (err) {
        if (!disposed) {
          setStatus("error");
          setMessage(err instanceof Error ? err.message : String(err));
        }
      }
    })();

    return () => {
      disposed = true;
      display?.stop();
    };
  }, [activeWorkspaceId, ensureSandbox]);

  if (!activeWorkspaceId) {
    return <NoWorkspacePlaceholder message="No active workspace. Create one to open the desktop." />;
  }

  return (
    <div className="relative h-full w-full bg-black">
      <canvas
        ref={canvasRef}
        className="h-full w-full"
        tabIndex={0}
        aria-label="Sandbox desktop"
      />
      {status !== "attached" && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="text-sm text-gray-400">
            {status === "booting" && "Booting in-page sandbox..."}
            {status === "error" && `Display error: ${message}`}
            {status === "idle" && "Idle"}
          </p>
        </div>
      )}
    </div>
  );
}
