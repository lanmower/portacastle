import { create } from "zustand";
import type { Workspace } from "@/types/workspace";
import type { SandboxInfo } from "@/types/sandbox";
import { useClientSandboxStore } from "@/stores/client-sandbox-store";

/**
 * Workspace lifecycle, in-page.
 *
 * The remote-VM model POSTed /api/sandbox/* to provision/stop/snapshot a Vercel
 * sandbox and persisted workspace metadata in a server DB. That whole backend is
 * gone: a workspace now owns ONE in-page portabox sandbox (booted via the
 * client-sandbox store), and its metadata (name/icon/background) is persisted
 * locally in localStorage. No external service is contacted.
 */

const LS_WORKSPACES = "sandcastle:workspaces";
const LS_LAST = "sandcastle:last-workspace";

function loadWorkspaces(): Workspace[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(LS_WORKSPACES);
    return raw ? (JSON.parse(raw) as Workspace[]) : [];
  } catch {
    return [];
  }
}

function saveWorkspaces(workspaces: Workspace[]) {
  try {
    localStorage.setItem(LS_WORKSPACES, JSON.stringify(workspaces));
  } catch {}
}

function uid(): string {
  // Local id; no server registry to coordinate with.
  return "ws-" + Math.random().toString(36).slice(2, 10);
}

function makeSandboxInfo(workspaceId: string): SandboxInfo {
  return {
    sandboxId: workspaceId,
    status: "active",
    workspaceId,
    createdAt: new Date().toISOString(),
  };
}

interface WorkspaceStore {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  sandboxes: Record<string, SandboxInfo>;
  creatingStatus: string | null;
  creatingError: string | null;

  hydrate: () => void;
  setWorkspaces: (workspaces: Workspace[]) => void;
  setActiveWorkspace: (id: string) => void;
  setSandboxInfo: (workspaceId: string, info: SandboxInfo) => void;
  removeSandboxInfo: (workspaceId: string) => void;
  markSandboxLost: (workspaceId: string) => void;
  createWorkspace: (name?: string) => Promise<Workspace>;
  updateWorkspace: (
    id: string,
    updates: { name?: string; icon?: string; background?: string | null },
  ) => Promise<void>;
  stopWorkspace: (id: string) => Promise<void>;
  killWorkspace: (id: string) => Promise<void>;
  killAllWorkspaces: () => Promise<void>;
  restartWorkspace: (id: string) => Promise<void>;
  reconnectWorkspace: (id: string) => Promise<void>;
  snapshotWorkspace: (id: string) => Promise<string>;
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,
  sandboxes: {},
  creatingStatus: null,
  creatingError: null,

  hydrate: () => {
    const workspaces = loadWorkspaces();
    let activeWorkspaceId: string | null = null;
    try {
      activeWorkspaceId = localStorage.getItem(LS_LAST);
    } catch {}
    if (!activeWorkspaceId || !workspaces.some((w) => w.id === activeWorkspaceId)) {
      activeWorkspaceId = workspaces[0]?.id ?? null;
    }
    set({ workspaces, activeWorkspaceId });
  },

  setWorkspaces: (workspaces) => {
    set({ workspaces });
    saveWorkspaces(workspaces);
  },

  setActiveWorkspace: (id) => {
    set({ activeWorkspaceId: id });
    try {
      localStorage.setItem(LS_LAST, id);
    } catch {}
  },

  setSandboxInfo: (workspaceId, info) => {
    set((state) => ({ sandboxes: { ...state.sandboxes, [workspaceId]: info } }));
  },

  removeSandboxInfo: (workspaceId) => {
    set((state) => ({
      sandboxes: Object.fromEntries(
        Object.entries(state.sandboxes).filter(([k]) => k !== workspaceId),
      ),
    }));
  },

  markSandboxLost: (workspaceId) => {
    set((state) => ({
      sandboxes: Object.fromEntries(
        Object.entries(state.sandboxes).filter(([k]) => k !== workspaceId),
      ),
      workspaces: state.workspaces.map((ws) =>
        ws.id === workspaceId
          ? { ...ws, status: "stopped" as const, sandboxId: null }
          : ws,
      ),
    }));
  },

  createWorkspace: async (name) => {
    set({ creatingStatus: "Booting in-page sandbox...", creatingError: null });
    const id = uid();
    const workspace: Workspace = {
      id,
      name: name || "Workspace",
      status: "active",
      sandboxId: id,
      snapshotId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as Workspace;
    try {
      await useClientSandboxStore.getState().ensureSandbox(id);
      set((state) => {
        const workspaces = [...state.workspaces, workspace];
        saveWorkspaces(workspaces);
        return {
          workspaces,
          activeWorkspaceId: id,
          sandboxes: { ...state.sandboxes, [id]: makeSandboxInfo(id) },
          creatingStatus: null,
          creatingError: null,
        };
      });
      try {
        localStorage.setItem(LS_LAST, id);
      } catch {}
      return workspace;
    } catch (err) {
      set({
        creatingStatus: null,
        creatingError: err instanceof Error ? err.message : "Failed to boot sandbox",
      });
      throw err;
    }
  },

  updateWorkspace: async (id, updates) => {
    set((state) => {
      const workspaces = state.workspaces.map((w) =>
        w.id === id ? { ...w, ...updates, updatedAt: new Date().toISOString() } : w,
      );
      saveWorkspaces(workspaces);
      return { workspaces };
    });
  },

  stopWorkspace: async (id) => {
    await useClientSandboxStore.getState().disposeSandbox(id);
    get().markSandboxLost(id);
    set((state) => {
      saveWorkspaces(state.workspaces);
      return {};
    });
  },

  killWorkspace: async (id) => {
    await useClientSandboxStore.getState().disposeSandbox(id);
    set((state) => {
      const remaining = state.workspaces.filter((w) => w.id !== id);
      const newActive =
        state.activeWorkspaceId === id
          ? remaining.find((w) => w.status === "active")?.id ?? remaining[0]?.id ?? null
          : state.activeWorkspaceId;
      saveWorkspaces(remaining);
      return {
        workspaces: remaining,
        activeWorkspaceId: newActive,
        sandboxes: Object.fromEntries(
          Object.entries(state.sandboxes).filter(([k]) => k !== id),
        ),
      };
    });
  },

  killAllWorkspaces: async () => {
    const { workspaces } = get();
    await Promise.all(
      workspaces.map((w) =>
        useClientSandboxStore.getState().disposeSandbox(w.id).catch(() => {}),
      ),
    );
    saveWorkspaces([]);
    set({ workspaces: [], activeWorkspaceId: null, sandboxes: {} });
  },

  restartWorkspace: async (id) => {
    const workspace = get().workspaces.find((w) => w.id === id);
    if (!workspace) return;
    set({ creatingStatus: "Restarting sandbox..." });
    const sb = useClientSandboxStore.getState();
    try {
      await sb.disposeSandbox(id);
      await sb.ensureSandbox(id);
      set((state) => ({
        activeWorkspaceId: id,
        sandboxes: { ...state.sandboxes, [id]: makeSandboxInfo(id) },
        workspaces: state.workspaces.map((w) =>
          w.id === id ? { ...w, status: "active" as const, sandboxId: id } : w,
        ),
        creatingStatus: null,
        creatingError: null,
      }));
    } catch (err) {
      set({
        creatingStatus: null,
        creatingError: err instanceof Error ? err.message : "Failed to restart sandbox",
      });
    }
  },

  reconnectWorkspace: async (id) => {
    // In-page sandboxes don't "die" the way remote VMs did; reconnect is just a
    // (re)boot of the in-page sandbox for the workspace.
    return get().restartWorkspace(id);
  },

  snapshotWorkspace: async (id) => {
    // In-page snapshot: capture the live sandbox's byte-exact memory+registers
    // in-memory. Returns the snapshot id the sandbox issues.
    const sandbox = useClientSandboxStore.getState().getSandbox(id);
    if (!sandbox) throw new Error("No active sandbox to snapshot");
    const snap = await sandbox.snapshot();
    return snap.snapshotId;
  },
}));

export function useActiveSandbox() {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const sandbox = useWorkspaceStore((s) =>
    s.activeWorkspaceId ? s.sandboxes[s.activeWorkspaceId] : null,
  );
  return { activeWorkspaceId, sandbox };
}
