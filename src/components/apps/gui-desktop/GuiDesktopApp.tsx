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

// Module-level guard: only ONE GUI frame pump per workspace may run, even
// across React strict-mode double-mounts (which would otherwise start two
// pumps racing the single-run blink VM).
const activePumps = new Set<string>();

export function GuiDesktopApp() {
  const { activeWorkspaceId } = useActiveSandbox();
  const ensureSandbox = useClientSandboxStore((s) => s.ensureSandbox);
  const runExclusive = useClientSandboxStore((s) => s.runExclusive);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState("idle");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !activeWorkspaceId) return;
    const wsId: string = activeWorkspaceId;
    canvas.width = GUEST_W;
    canvas.height = GUEST_H;
    const ctx = canvas.getContext("2d", { alpha: false })!;
    // Persistent backbuffer: allocated ONCE and reused every frame. Allocating
    // a fresh 1.9MB ImageData per frame churns the GC and is the single largest
    // avoidable per-frame cost in the blit path.
    const frame = ctx.createImageData(GUEST_W, GUEST_H);
    let running = true;
    let raf = 0;
    // Last framebuffer generation we blitted; the guest bumps fbView().generation
    // on every fb register, so an unchanged generation means the pixels are
    // identical and the putImageData can be skipped entirely.
    let lastGen = -1;

    // Window drag state carried across frames (mirrors xappdemo argv contract).
    const win = { x: 220, y: 150, dragging: 0, grabx: 0, graby: 0 };
    // Latest pointer state collected from canvas events between frames.
    // requestTick is wired by the frame pump below to re-render on input.
    const pointer = { x: -1, y: -1, downPending: null as number | null, requestTick: (() => {}) as () => void };

    function onMove(e: MouseEvent) {
      const r = canvas!.getBoundingClientRect();
      pointer.x = Math.round((e.clientX - r.left) * GUEST_W / r.width);
      pointer.y = Math.round((e.clientY - r.top) * GUEST_H / r.height);
      pointer.requestTick();
    }
    function onDown() { pointer.downPending = 1; pointer.requestTick(); }
    function onUp() { pointer.downPending = 0; pointer.requestTick(); }
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
      // Only one pump per workspace (strict-mode dedupe).
      if (activePumps.has(wsId)) { setStatus("running"); return; }
      activePumps.add(wsId);
      // Write the GUI ELF into the guest FS once (serialized against any other
      // VM work via runExclusive); each frame execs /xappdemo.
      const bytes = new Uint8Array(await (await fetch(ELF_URL)).arrayBuffer());
      await runExclusive(wsId, (sb) =>
        sb.writeFiles([{ path: "/xappdemo", content: bytes, mode: 0o755 }]),
      );
      // expose for live debugging (window.__sc.gui)
      const dbg = {
        lastOut: null as string | null,
        lastErr: null as string | null,
        win,
        pointer,
        frames: 0, // total ticks
        blits: 0, // ticks that actually blitted (generation changed)
        lastGenSeen: -1,
      };
      (window as unknown as { __sc?: Record<string, unknown> }).__sc ??= {};
      (window as unknown as { __sc: Record<string, unknown> }).__sc.gui = dbg;
      setStatus("running");

      // Single-flight, self-pacing frame pump. tick() runs exactly ONE guest
      // frame and never re-enters (inFlight guard) -- the blink VM allows one
      // run at a time, so overlap is forbidden. After each frame it schedules
      // the next via requestAnimationFrame only if more input arrived or a drag
      // is active; otherwise it idles until requestTick() is called by an input
      // event. This keeps the window live + interactive without a free-running
      // timer racing the VM, and pauses entirely when the tab is backgrounded.
      let inFlight = false;
      let dirty = true; // first frame always renders
      function requestTick() { dirty = true; if (!inFlight && running) void tick(); }

      async function tick() {
        if (inFlight || !running) return;
        inFlight = true;
        dirty = false;
        try {
          await runExclusive(wsId, async (sb) => {
            if (pointer.x >= 0) await sb.pushInput({ type: "motion", x: pointer.x, y: pointer.y });
            if (pointer.downPending !== null) {
              await sb.pushInput({ type: "button", button: 0, down: pointer.downPending });
              pointer.downPending = null;
              dirty = true;
            }
            const argv = [String(win.x), String(win.y), String(win.dragging), String(win.grabx), String(win.graby)];
            const r = await sb.runCommand("/xappdemo", argv);
            const stdoutStr = await r.stdout();
            dbg.lastOut = stdoutStr;
            // Guest line: "x y drag gx gy | r g b ! damage". State is left of
            // '!', the damage flag (1=visible change, 0=identical) is right of it.
            const [statePart, damagePart] = stdoutStr.trim().split("!");
            const out = statePart.split(/[\s|]+/).map(Number);
            if (out.length >= 5 && Number.isFinite(out[0])) {
              win.x = out[0]; win.y = out[1]; win.dragging = out[2]; win.grabx = out[3]; win.graby = out[4];
            }
            // damage defaults to 1 (always blit) when the token is absent (older
            // ELF), so a missing damage signal never freezes the display.
            const damage = damagePart === undefined ? 1 : Number(damagePart.trim());
            const view = await sb.displayPixels();
            if (view && view.pixels && view.width === GUEST_W && view.height === GUEST_H
                && view.pixels.length === GUEST_W * GUEST_H * 4
                && view.generation !== lastGen
                && damage !== 0) {
              // Copy into the persistent backbuffer (no per-frame allocation) and
              // blit only when the generation advanced AND the guest reports the
              // frame actually changed -- a damage=0 run skips the 1.9MB copy +
              // canvas upload since the displayed frame is already current.
              frame.data.set(view.pixels);
              ctx.putImageData(frame, 0, 0);
              lastGen = view.generation;
              dbg.blits++;
            }
            if (view) dbg.lastGenSeen = view.generation;
            dbg.frames++;
          });
        } catch (err) {
          dbg.lastErr =
            err instanceof Error
              ? err.message + (err.stack ? "\n" + err.stack.slice(0, 300) : "")
              : (() => { try { return JSON.stringify(err); } catch { return String(err); } })();
        } finally {
          inFlight = false;
          // keep animating while dragging (content block animates), else idle.
          // requestAnimationFrame coalesces with the compositor and is paused
          // automatically when the tab is backgrounded (no wasted VM runs).
          if (running && (dirty || win.dragging)) raf = requestAnimationFrame(() => void tick());
        }
      }
      pointer.requestTick = requestTick;
      void tick();
    })();

    return () => {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      activePumps.delete(wsId);
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mousedown", onDown);
      canvas.removeEventListener("mouseup", onUp);
    };
  }, [activeWorkspaceId, ensureSandbox, runExclusive]);

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
