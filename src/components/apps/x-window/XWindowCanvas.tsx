"use client";

import { useEffect, useRef, useState } from "react";
import { useClientSandboxStore } from "@/stores/client-sandbox-store";
import { getPerf } from "@/lib/perf";

/**
 * Live X window canvas. Blits the in-page persistent Xvfb framebuffer (published
 * by the patched Xvfb via syscall 0x5fb, page-walked by the host fbView) to a
 * <canvas> on requestAnimationFrame, and forwards pointer/key input to the X
 * server via the 0x5fc input ring (sandbox.pushInput).
 *
 * Unlike GuiDesktopApp (which execs a render-once ELF per frame), the X server
 * runs CONTINUOUSLY on its own worker pthread, so this component never drives
 * the VM — it only SAMPLES the framebuffer each rAF and uploads changed frames.
 * The launch (startXServer + launchXClient) is done by launchXApp before the
 * window opens; this component is purely the display + input surface.
 *
 * Replaces the removed xpra XpraWindow render path (remote VM + xpra protocol).
 */
const FB_W = 800;
const FB_H = 600;

export function XWindowCanvas({ workspaceId }: { workspaceId: string }) {
  const ensureSandbox = useClientSandboxStore((s) => s.ensureSandbox);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState("connecting");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !workspaceId) return;
    canvas.width = FB_W;
    canvas.height = FB_H;
    const ctx = canvas.getContext("2d", { alpha: false })!;
    // One persistent backbuffer reused every frame (no per-frame 1.9MB alloc).
    let frame: ImageData | null = null;
    let running = true;
    let raf = 0;
    let lastGen = -1;

    // Map a canvas event to guest framebuffer coordinates.
    function toGuest(e: MouseEvent) {
      const r = canvas!.getBoundingClientRect();
      return {
        x: Math.round(((e.clientX - r.left) * FB_W) / r.width),
        y: Math.round(((e.clientY - r.top) * FB_H) / r.height),
      };
    }

    let sandbox: Awaited<ReturnType<typeof ensureSandbox>> | null = null;

    // Coalesce pointer-motion: a fast drag fires mousemove hundreds of times a
    // second, but the X server only needs the LATEST position per frame. Stash
    // the latest motion here and flush at most one per rAF tick (below), instead
    // of writing the input ring on every native event.
    let pendingMotion: { x: number; y: number } | null = null;

    function onMove(e: MouseEvent) {
      if (!sandbox) return;
      pendingMotion = toGuest(e);
    }
    function onDown(e: MouseEvent) {
      if (!sandbox) return;
      const { x, y } = toGuest(e);
      void sandbox.pushInput({ type: "button", button: e.button, x, y, down: 1 });
    }
    function onUp(e: MouseEvent) {
      if (!sandbox) return;
      const { x, y } = toGuest(e);
      void sandbox.pushInput({ type: "button", button: e.button, x, y, down: 0 });
    }
    function onKey(e: KeyboardEvent) {
      if (!sandbox) return;
      // Forward the keycode; the X server maps it via the precompiled keymap.
      void sandbox.pushInput({ type: "key", code: e.keyCode, down: e.type === "keydown" ? 1 : 0 });
      e.preventDefault();
    }
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mousedown", onDown);
    canvas.addEventListener("mouseup", onUp);
    canvas.addEventListener("keydown", onKey);
    canvas.addEventListener("keyup", onKey);

    (async () => {
      try {
        sandbox = await ensureSandbox(workspaceId);
      } catch (err) {
        if (running) setStatus("error: " + (err instanceof Error ? err.message : String(err)));
        return;
      }
      if (!running) return;
      setStatus("running");

      // Free-running sample loop: the X server paints its framebuffer on its own
      // worker; we blit the latest frame each rAF when the generation advanced.
      // rAF auto-pauses when the tab is backgrounded. displayPixels() is the
      // host page-walk over the live Xvfb framebuffer.
      async function tick() {
        if (!running || !sandbox) return;
        const rec = getPerf().begin("xwindow");
        let painted = false;
        try {
          // Flush the single latest coalesced pointer position for this frame.
          if (pendingMotion) {
            const m = pendingMotion; pendingMotion = null;
            void sandbox.pushInput({ type: "motion", x: m.x, y: m.y });
          }
          // Cheap generation probe BEFORE the 1.9MB page-walk: displayInfo()
          // returns the framebuffer generation without copying pixels. On an
          // idle frame (generation unchanged) we skip displayPixels() entirely,
          // so a static X window costs ~0 per rAF instead of a full fb copy.
          const info = await rec.stageAsync("displayInfo", () => sandbox!.displayInfo());
          if (info && info.generation === lastGen) {
            rec.end(false);
            if (running) raf = requestAnimationFrame(() => void tick());
            return;
          }
          const view = await rec.stageAsync("displayPixels", () => sandbox!.displayPixels());
          if (
            view &&
            view.pixels &&
            view.width > 0 &&
            view.height > 0 &&
            view.generation !== lastGen
          ) {
            // (Re)size the canvas + backbuffer if the Xvfb geometry differs from
            // the default (e.g. a non-800x600 screen).
            if (canvas!.width !== view.width || canvas!.height !== view.height) {
              canvas!.width = view.width;
              canvas!.height = view.height;
              frame = null;
            }
            if (!frame || frame.width !== view.width || frame.height !== view.height) {
              frame = ctx.createImageData(view.width, view.height);
            }
            if (view.pixels.length === view.width * view.height * 4) {
              const f = frame;
              rec.stage("blit", () => {
                f.data.set(view.pixels);
                ctx.putImageData(f, 0, 0);
              });
              lastGen = view.generation;
              painted = true;
            }
          }
        } catch {
          /* transient (VM busy with a client launch) — retry next tick */
        }
        rec.end(painted);
        if (running) raf = requestAnimationFrame(() => void tick());
      }
      void tick();
    })();

    return () => {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mousedown", onDown);
      canvas.removeEventListener("mouseup", onUp);
      canvas.removeEventListener("keydown", onKey);
      canvas.removeEventListener("keyup", onKey);
    };
  }, [workspaceId, ensureSandbox]);

  return (
    <div className="relative h-full w-full bg-black">
      <canvas
        ref={canvasRef}
        className="h-full w-full"
        style={{ imageRendering: "pixelated", objectFit: "contain" }}
        tabIndex={0}
        aria-label="Live X application window"
      />
      {status !== "running" && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="text-sm text-gray-400">{status}</p>
        </div>
      )}
    </div>
  );
}
