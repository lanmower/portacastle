"use client";

import { useEffect, useRef, useState } from "react";
import { useActiveSandbox } from "@/stores/workspace-store";
import { useClientSandboxStore, BOOT_STAGE_LABEL } from "@/stores/client-sandbox-store";
import { NoWorkspacePlaceholder } from "@/components/apps/no-workspace-placeholder";
import { asset } from "@/lib/static-export";
import { getPerf } from "@/lib/perf";

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
const ELF_URL = asset("/containers/xappdemo.elf");

// Module-level guard: only ONE GUI frame pump per workspace may run, even
// across React strict-mode double-mounts (which would otherwise start two
// pumps racing the single-run blink VM).
const activePumps = new Set<string>();

export function GuiDesktopApp() {
  const { activeWorkspaceId } = useActiveSandbox();
  const ensureSandbox = useClientSandboxStore((s) => s.ensureSandbox);
  const runExclusive = useClientSandboxStore((s) => s.runExclusive);
  const bootStage = useClientSandboxStore((s) =>
    activeWorkspaceId ? s.bootStage[activeWorkspaceId] : undefined,
  );
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState("idle");
  // True once at least one guest frame has actually blitted pixels to the
  // canvas. Until then a "running" GUI with no framebuffer output would be an
  // uninterpretable black rectangle, so we surface a diagnostic overlay instead
  // (mirrors XWindowCanvas's never-silent-black invariant).
  const [hasPainted, setHasPainted] = useState(false);
  // Set when the pump has run several frames without ever producing a blit:
  // the ELF executes but no pixels reach the framebuffer (the documented
  // in-guest fb path that does not flush paint), so the canvas stays black.
  const [noOutput, setNoOutput] = useState(false);

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
      // Await boot for its side effects + error surfacing only; the frame pump
      // reaches the sandbox through runExclusive, so the handle itself is unused.
      try {
        await ensureSandbox(activeWorkspaceId);
      } catch (err) {
        if (running) setStatus("error: " + (err instanceof Error ? err.message : String(err)));
        return;
      }
      if (!running) return;
      // Only one pump per workspace (strict-mode dedupe).
      if (activePumps.has(wsId)) { setStatus("running"); return; }
      activePumps.add(wsId);
      // Write the GUI ELF into the guest FS once (serialized against any other
      // VM work via runExclusive); each frame execs /xappdemo. no-store so a
      // rebuilt ELF is picked up on reload instead of the stale HTTP-cached copy.
      const bytes = new Uint8Array(await (await fetch(ELF_URL, { cache: "no-store" })).arrayBuffer());
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
        parseMs: 0, // measured per-frame stdout-parse cost (superseded-by-worker)
      };
      (window as unknown as { __sc?: Record<string, unknown> }).__sc ??= {};
      (window as unknown as { __sc: Record<string, unknown> }).__sc.gui = dbg;
      // Expose the sandbox store too: one Sandbox per workspace is held there
      // for the page lifetime, so it's the handle that proves terminal + GUI +
      // file ops all share one in-page VM/FS (window.__sc.clientSandbox).
      (window as unknown as { __sc: Record<string, unknown> }).__sc.clientSandbox = useClientSandboxStore;
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
      // Live pump-state mirror for browser-witness diagnosis of the re-tick path.
      const pump = { inFlight: false, dirty: true, running: true, ticks: 0, requestTicks: 0 };
      (dbg as unknown as { pump: typeof pump }).pump = pump;
      function requestTick() {
        dirty = true; pump.dirty = true; pump.requestTicks++;
        if (!inFlight && running) void tick();
      }

      async function tick() {
        if (inFlight || !running) return;
        inFlight = true; pump.inFlight = true; pump.ticks++;
        dirty = false; pump.dirty = false;
        const rec = getPerf().begin("gui");
        let painted = false;
        try {
          await runExclusive(wsId, async (sb) => {
            if (pointer.x >= 0) await sb.pushInput({ type: "motion", x: pointer.x, y: pointer.y });
            if (pointer.downPending !== null) {
              await sb.pushInput({ type: "button", button: 0, down: pointer.downPending });
              pointer.downPending = null;
              dirty = true;
            }
            const argv = [String(win.x), String(win.y), String(win.dragging), String(win.grabx), String(win.graby)];
            const r = await rec.stageAsync("exec", () => sb.runCommand("/xappdemo", argv));
            const stdoutStr = await rec.stageAsync("stdout", () => r.stdout());
            dbg.lastOut = stdoutStr;
            // Guest line: "x y drag gx gy | r g b ! damage". State is left of
            // '!', the damage flag (1=visible change, 0=identical) is right of it.
            // PERF NOTE (measured): this per-frame stdout capture + string parse
            // is a deliberate cost of the render-once model. dbg.parseMs records
            // the parse time so it is observable (window.__sc.gui.parseMs). It is
            // SUPERSEDED-BY-WORKER: once the VM runs in a Web Worker with shared
            // memory, the window state lives in shared memory and this stdout
            // round-trip disappears. Measured cost is sub-millisecond (a short
            // split/map over a one-line string), so it is not the per-frame
            // bottleneck -- the blit + runElf dominate; left as-is intentionally.
            const _parse0 = performance.now();
            // stdout may carry a shell-prompt prefix ("$ xappdemo\n...") and
            // blank lines; take the LAST line that actually contains the state
            // marker '|' so the prompt text never poisons the numeric parse.
            const stateLine =
              stdoutStr
                .split("\n")
                .map((l) => l.trim())
                .filter((l) => l.includes("|"))
                .pop() ?? stdoutStr.trim();
            const [statePart, damagePart] = stateLine.split("!");
            const out = statePart.split(/[\s|]+/).filter(Boolean).map(Number);
            dbg.parseMs = performance.now() - _parse0;
            if (out.length >= 5 && Number.isFinite(out[0])) {
              win.x = out[0]; win.y = out[1]; win.dragging = out[2]; win.grabx = out[3]; win.graby = out[4];
            }
            // damage defaults to 1 (always blit) when the token is absent OR
            // empty/non-numeric (older ELF, trailing whitespace) so a missing or
            // blank damage signal never freezes the display by reading as 0.
            const damageNum = damagePart === undefined ? NaN : Number(damagePart.trim());
            const damage = Number.isFinite(damageNum) ? damageNum : 1;
            // Cheap generation probe before the 1.9MB displayPixels copy: if the
            // guest didn't re-register the framebuffer (generation unchanged) AND
            // it isn't the first paint, skip the pixel snapshot entirely -- the
            // displayed frame is already current. displayInfo() reads only the
            // fb header, not the pixels.
            const firstPaintProbe = lastGen < 0;
            const info = await rec.stageAsync("displayInfo", () => sb.displayInfo());
            const view =
              info && info.generation === lastGen && !firstPaintProbe
                ? null
                : await rec.stageAsync("displayPixels", () => sb.displayPixels());
            // The very first paint (lastGen<0) must always blit so the window
            // appears even when the opening frame reports damage=0; after that,
            // skip the copy on unchanged (damage=0) frames.
            const firstPaint = lastGen < 0;
            if (view && view.pixels && view.width === GUEST_W && view.height === GUEST_H
                && view.pixels.length === GUEST_W * GUEST_H * 4
                && view.generation !== lastGen
                && (damage !== 0 || firstPaint)) {
              // Copy into the persistent backbuffer (no per-frame allocation) and
              // blit only when the generation advanced AND (the guest reports the
              // frame changed OR it's the first paint) -- a damage=0 run after the
              // first paint skips the 1.9MB copy + canvas upload since the
              // displayed frame is already current.
              rec.stage("blit", () => {
                frame.data.set(view.pixels);
                ctx.putImageData(frame, 0, 0);
              });
              lastGen = view.generation;
              dbg.blits++;
              painted = true;
              // First real blit: clear any diagnostic and mark painted. setState
              // bails on unchanged values, so calling every blit is cheap.
              setHasPainted(true);
              setNoOutput(false);
            }
            if (view) dbg.lastGenSeen = view.generation;
            dbg.frames++;
            // Several frames executed with zero blits => the guest ran but never
            // flushed pixels to the framebuffer. Surface that precisely instead
            // of leaving a mute black canvas.
            if (dbg.blits === 0 && dbg.frames >= 3) setNoOutput(true);
          });
        } catch (err) {
          dbg.lastErr =
            err instanceof Error
              ? err.message + (err.stack ? "\n" + err.stack.slice(0, 300) : "")
              : (() => { try { return JSON.stringify(err); } catch { return String(err); } })();
        } finally {
          rec.end(painted);
          inFlight = false; pump.inFlight = false;
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
      {(status !== "running" || !hasPainted) && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
          <p
            className="max-w-md text-center text-sm text-gray-400"
            data-boot-stage={bootStage ?? ""}
          >
            {status === "booting"
              ? bootStage
                ? BOOT_STAGE_LABEL[bootStage]
                : "Booting in-page sandbox..."
              : status !== "running"
                ? status
                : noOutput
                  ? "GUI is running but produced no framebuffer output yet. " +
                    "The in-guest program executes but no pixels have reached " +
                    "the framebuffer; the canvas stays blank until that lands."
                  : "Starting GUI..."}
          </p>
        </div>
      )}
    </div>
  );
}
