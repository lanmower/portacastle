import { create } from "zustand";
import type { Sandbox } from "portabox";
import { asset } from "@/lib/static-export";

/**
 * In-page sandbox store.
 *
 * Replaces the remote-VM lifecycle (POST /api/sandbox/*) with a portabox
 * Sandbox that runs the x86_64 Linux userspace ENTIRELY in the browser via the
 * webix Blink WASM emulator -- no server, no external service calls. One
 * Sandbox is booted per workspace and held here for the page's lifetime.
 *
 * The WASM/glue/rootfs are served same-origin from /containers (see
 * public/containers + next.config headers, which also set COOP/COEP so the
 * threaded build's SharedArrayBuffer works).
 *
 * Consumers:
 *   - Terminal: sandbox.runCommand(cmd, args)
 *   - File Manager: sandbox.fs (node:fs/promises-compatible)
 *   - Desktop: sandbox.attachDisplay(canvas) + sandbox.pushInput(evt)
 */

// Base-pathed under static export (GitHub Pages serves under /<repo>/).
const CONTAINERS = asset("/containers");

export type SandboxStatus =
  | "idle"
  | "booting"
  | "ready"
  | "error";

/** Cold-boot stage label per workspace, for a legible boot indicator. */
export type BootStage = "runtime" | "rootfs" | "mount" | "ready";
export const BOOT_STAGE_LABEL: Record<BootStage, string> = {
  runtime: "Fetching runtime...",
  rootfs: "Fetching filesystem...",
  mount: "Mounting filesystem...",
  ready: "Ready",
};

interface ClientSandboxStore {
  /** The live portabox Sandbox per workspace id. */
  sandboxes: Record<string, Sandbox>;
  status: Record<string, SandboxStatus>;
  /** Cold-boot stage per workspace (drives the boot-progress indicator). */
  bootStage: Record<string, BootStage | undefined>;
  error: Record<string, string | null>;

  /**
   * Boot (or return the already-booted) in-page sandbox for a workspace.
   * Idempotent: concurrent calls share one boot.
   */
  ensureSandbox: (workspaceId: string) => Promise<Sandbox>;
  /** Dispose a workspace's sandbox and drop it from the store. */
  disposeSandbox: (workspaceId: string) => Promise<void>;
  getSandbox: (workspaceId: string) => Sandbox | undefined;
  /**
   * Serialize work against a workspace's single in-page VM. blink runs one ELF
   * at a time (runElf throws "previous run not yet settled" on overlap), so the
   * terminal, GUI frame loop, file ops, etc. must take turns. runExclusive
   * chains callbacks per workspace so only one is ever in flight.
   */
  runExclusive: <T>(workspaceId: string, fn: (sandbox: Sandbox) => Promise<T>) => Promise<T>;
}

// In-flight boots, keyed by workspace id, so ensureSandbox is race-safe.
const booting = new Map<string, Promise<Sandbox>>();
// Per-workspace serialization chain so VM runs never overlap.
const runChains = new Map<string, Promise<unknown>>();
// Workspaces whose IDBFS persist-flush listeners are already wired (once each),
// with the teardown that clears the interval + removes the window listeners so a
// disposed sandbox does not leak a 15s timer (and the closures it retains).
const persistFlushWired = new Map<string, () => void>();

export const useClientSandboxStore = create<ClientSandboxStore>((set, get) => ({
  sandboxes: {},
  status: {},
  bootStage: {},
  error: {},

  getSandbox(workspaceId) {
    return get().sandboxes[workspaceId];
  },

  runExclusive(workspaceId, fn) {
    const prev = runChains.get(workspaceId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      const sandbox = await get().ensureSandbox(workspaceId);
      return fn(sandbox);
    });
    // keep the chain alive regardless of individual failures
    runChains.set(workspaceId, next.catch(() => {}));
    return next;
  },

  async ensureSandbox(workspaceId) {
    const existing = get().sandboxes[workspaceId];
    if (existing) return existing;
    const inflight = booting.get(workspaceId);
    if (inflight) return inflight;

    set((s) => ({
      status: { ...s.status, [workspaceId]: "booting" },
      error: { ...s.error, [workspaceId]: null },
    }));

    const boot = (async () => {
      // Dynamic import keeps portabox (and the multi-MB wasm it pulls) out of
      // the initial bundle; the sandbox boots lazily when a workspace opens.
      const { Sandbox } = await import("portabox");
      const sandbox = await Sandbox.create({
        name: workspaceId,
        wasmUrl: `${CONTAINERS}/blinkenlib.wasm`,
        glueUrl: `${CONTAINERS}/blinkenlib.js`,
        rootfsUrl: `${CONTAINERS}/alpine-minirootfs-x86_64.tar.gz`,
        // Surface cold-boot stages so the boot UI is legible (not a flat spinner).
        onProgress: (stage: BootStage) =>
          set((s) => ({ bootStage: { ...s.bootStage, [workspaceId]: stage } })),
      });
      // Mount an IDBFS-backed /persist dir + load it from IndexedDB, so files
      // written under /persist survive a page reload. Best-effort: a build
      // without IDBFS, or a privacy mode without IndexedDB, simply skips it.
      try {
        await sandbox.persistDir("/persist");
        if (!persistFlushWired.has(workspaceId)) {
          const flush = () => { void sandbox.syncPersist().catch(() => {}); };
          // Flush on tab hide/close + periodically, so writes are durable.
          if (typeof window !== "undefined") {
            window.addEventListener("beforeunload", flush);
            window.addEventListener("pagehide", flush);
            const timer = setInterval(flush, 15000);
            // Teardown: clear the interval + drop the listeners so disposing the
            // sandbox does not leak a timer (which would also retain `sandbox`).
            persistFlushWired.set(workspaceId, () => {
              clearInterval(timer);
              window.removeEventListener("beforeunload", flush);
              window.removeEventListener("pagehide", flush);
            });
          } else {
            persistFlushWired.set(workspaceId, () => {});
          }
        }
      } catch {
        /* IDBFS unavailable; non-persistent session */
      }
      return sandbox;
    })();

    booting.set(workspaceId, boot);
    try {
      const sandbox = await boot;
      set((s) => ({
        sandboxes: { ...s.sandboxes, [workspaceId]: sandbox },
        status: { ...s.status, [workspaceId]: "ready" },
      }));
      return sandbox;
    } catch (err) {
      set((s) => ({
        status: { ...s.status, [workspaceId]: "error" },
        error: {
          ...s.error,
          [workspaceId]: err instanceof Error ? err.message : String(err),
        },
      }));
      throw err;
    } finally {
      booting.delete(workspaceId);
    }
  },

  async disposeSandbox(workspaceId) {
    // Tear down the persist-flush interval + window listeners for this workspace
    // so a disposed sandbox leaves no live 15s timer holding the VM alive.
    const teardown = persistFlushWired.get(workspaceId);
    if (teardown) { teardown(); persistFlushWired.delete(workspaceId); }
    const sandbox = get().sandboxes[workspaceId];
    if (sandbox) {
      try {
        await sandbox.stop();
      } catch {
        // best-effort; the in-page VM is torn down regardless
      }
    }
    set((s) => {
      const sandboxes = { ...s.sandboxes };
      delete sandboxes[workspaceId];
      const status = { ...s.status, [workspaceId]: "idle" as SandboxStatus };
      return { sandboxes, status };
    });
  },
}));
