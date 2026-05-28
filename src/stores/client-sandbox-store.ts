import { create } from "zustand";
import type { Sandbox } from "portabox";

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

const CONTAINERS = "/containers";

export type SandboxStatus =
  | "idle"
  | "booting"
  | "ready"
  | "error";

interface ClientSandboxStore {
  /** The live portabox Sandbox per workspace id. */
  sandboxes: Record<string, Sandbox>;
  status: Record<string, SandboxStatus>;
  error: Record<string, string | null>;

  /**
   * Boot (or return the already-booted) in-page sandbox for a workspace.
   * Idempotent: concurrent calls share one boot.
   */
  ensureSandbox: (workspaceId: string) => Promise<Sandbox>;
  /** Dispose a workspace's sandbox and drop it from the store. */
  disposeSandbox: (workspaceId: string) => Promise<void>;
  getSandbox: (workspaceId: string) => Sandbox | undefined;
}

// In-flight boots, keyed by workspace id, so ensureSandbox is race-safe.
const booting = new Map<string, Promise<Sandbox>>();

export const useClientSandboxStore = create<ClientSandboxStore>((set, get) => ({
  sandboxes: {},
  status: {},
  error: {},

  getSandbox(workspaceId) {
    return get().sandboxes[workspaceId];
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
      });
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
