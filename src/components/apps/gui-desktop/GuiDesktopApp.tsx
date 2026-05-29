"use client";

import { useEffect, useRef, useState } from "react";
import { useActiveSandbox } from "@/stores/workspace-store";
import { useClientSandboxStore } from "@/stores/client-sandbox-store";
import { NoWorkspacePlaceholder } from "@/components/apps/no-workspace-placeholder";

/**
 * GUI Desktop app: runs an in-guest framebuffer GUI program (containers/
 * xappdemo.elf) and shows it live on a <canvas>.
 *
 * Architecture (render-once host-driven loop): the in-page sandbox's runElf is
 * synchronous, so a forever-looping GUI app would freeze the page. Instead the
 * guest app renders exactly ONE frame per run (drain input -> update window
 * drag state -> paint -> register framebuffer -> print new window state ->
 * exit), and this component re-runs it each animation tick, feeding the latest
 * pointer state through the input ring and carrying the window state across
 * frames via argv. Between runs it reads the guest framebuffer
 * (sandbox.displayInfo + the host fbView) and blits it to the canvas. The whole
 * GUI thing runs in the page; no server.
 */
const GUEST_W = 800;
const GUEST_H = 600;
const ELF_URL = "/containers/xappdemo.elf";
const FRAME_MS = 60; // host re-run cadence (each run is one guest frame)

export function GuiDesktopApp() {
  const { activeWorkspaceId } = useActiveSandbox();
  const ensureSandbox = useClientSandboxStore((s) => s.ensureSandbox);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState("idle");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !activeWorkspaceId) return;
    canvas.width = GUEST_W;
    canvas.height = GUEST_H;
    const ctx = canvas.getContext("2d", { alpha: false })!;
    let running = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Window drag state carried across frames (mirrors xappdemo argv contract).
    const win = { x: 220, y: 150, dragging: 0, grabx: 0, graby: 0 };
    // Latest pointer state collected from canvas events between frames.
    const pointer = { x: -1, y: -1, downPending: null as number | null };

    function onMove(e: MouseEvent) {
      const r = canvas!.getBoundingClientRect();
      pointer.x = Math.round((e.clientX - r.left) * GUEST_W / r.width);
      pointer.y = Math.round((e.clientY - r.top) * GUEST_H / r.height);
    }
    function onDown() { pointer.downPending = 1; }
    function onUp() { pointer.downPending = 0; }
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mousedown", onDown);
    canvas.addEventListener("mouseup", onUp);

    (async () => {
      setStatus("booting");
      let sandbox;
      try {
        sandbox = await ensureSandbox(activeWorkspaceId);
      } catch (err) {
        if (running) setStatus("error: " + (err instanceof Error ? err.message : String(err)));
        return;
      }
      if (!running) return;
      // Load the GUI ELF once; preload so each frame reuses the FS handle.
      const bytes = new Uint8Array(await (await fetch(ELF_URL)).arrayBuffer());
      // @ts-expect-error portabox exposes the underlying host preload via core
      const handle = sandbox.preloadFile?.("xappdemo", bytes) ?? null;
      setStatus("running");

      async function frame() {
        if (!running) return;
        // forward pointer state into the guest input ring before the run
        if (pointer.x >= 0) await sandbox!.pushInput({ type: "motion", x: pointer.x, y: pointer.y });
        if (pointer.downPending !== null) {
          await sandbox!.pushInput({ type: "button", button: 0, down: pointer.downPending });
          pointer.downPending = null;
        }
        const argv = ["xappdemo", String(win.x), String(win.y), String(win.dragging), String(win.grabx), String(win.graby)];
        try {
          const r = handle
            ? await sandbox!.runCommand("/xappdemo", argv.slice(1))
            : await (async () => {
                await sandbox!.writeFiles([{ path: "/xappdemo", content: bytes, mode: 0o755 }]);
                return sandbox!.runCommand("/xappdemo", argv.slice(1));
              })();
          // parse "x y dragging grabx graby"
          const out = (await r.stdout()).trim().split(/\s+/).map(Number);
          if (out.length >= 5 && Number.isFinite(out[0])) {
            win.x = out[0]; win.y = out[1]; win.dragging = out[2]; win.grabx = out[3]; win.graby = out[4];
          }
          // blit the guest framebuffer to the canvas
          const view = sandbox!.fbView ? sandbox!.fbView() : null;
          if (view && view.pixels) {
            const img = new ImageData(new Uint8ClampedArray(view.pixels.buffer, view.pixels.byteOffset, GUEST_W * GUEST_H * 4), GUEST_W, GUEST_H);
            ctx.putImageData(img, 0, 0);
          }
        } catch {
          // a frame can fail if a run overlaps; skip and continue
        }
        if (running) timer = setTimeout(frame, FRAME_MS);
      }
      frame();
    })();

    return () => {
      running = false;
      if (timer) clearTimeout(timer);
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mousedown", onDown);
      canvas.removeEventListener("mouseup", onUp);
    };
  }, [activeWorkspaceId, ensureSandbox]);

  if (!activeWorkspaceId) {
    return <NoWorkspacePlaceholder message="No active workspace. Create one to open the GUI desktop." />;
  }

  return (
    <div className="relative h-full w-full bg-black">
      <canvas
        ref={canvasRef}
        className="h-full w-full"
        style={{ imageRendering: "pixelated", objectFit: "contain" }}
        tabIndex={0}
        aria-label="In-guest GUI desktop"
      />
      {status !== "running" && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="text-sm text-gray-400">{status === "booting" ? "Booting in-page sandbox…" : status}</p>
        </div>
      )}
    </div>
  );
}
