"use client";

import useSWR, { mutate } from "swr";
import useSWRImmutable from "swr/immutable";
import type { Workspace } from "@/types/workspace";
import type { SandboxInfo } from "@/types/sandbox";
import type { DesktopEntry } from "@/types/desktop-entry";
import { fetcher, SWR_KEYS } from "@/lib/swr";
import { sandboxServiceFetcher } from "@/lib/hooks/use-sandbox-service-client";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { IS_STATIC_EXPORT } from "@/lib/static-export";

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

interface VercelAccountInfo {
  providerAccountId: string;
  scope: string | null;
  connectedAt: string;
}

interface AuthUser {
  id: string;
  email: string | null;
  name: string | null;
  role: "user" | "admin" | "guest";
  workspaceLimit: number | null;
  vercelConnected: boolean;
  vercelAccount: VercelAccountInfo | null;
}

// Static guest used on the GitHub Pages build, where /api/auth/me does not
// exist. Matches the server session shape for a guest, with unlimited local
// workspaces and no Vercel link.
const STATIC_GUEST: AuthUser = {
  id: "static-guest",
  email: null,
  name: "Guest",
  role: "guest",
  workspaceLimit: null,
  vercelConnected: false,
  vercelAccount: null,
};

export function useUser() {
  // Static export: no /api/auth/me endpoint -- return the synthetic guest and
  // never fetch (passing null as the SWR key disables the request).
  const { data, error, isLoading } = useSWR<AuthUser>(
    IS_STATIC_EXPORT ? null : SWR_KEYS.user,
    fetcher,
    {
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    },
  );
  if (IS_STATIC_EXPORT) {
    return { user: STATIC_GUEST, isLoading: false, error: undefined };
  }
  return {
    user: data ?? null,
    isLoading,
    error: error as Error | undefined,
  };
}

export async function loginMutate(email: string, password: string) {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const { error } = await res.json();
    throw new Error(error);
  }
  const user = await res.json();
  await mutate(SWR_KEYS.user, user, { revalidate: false });
  return user as AuthUser;
}

export async function signupMutate(
  email: string,
  password: string,
  name?: string,
) {
  const res = await fetch("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name }),
  });
  if (!res.ok) {
    const { error } = await res.json();
    throw new Error(error);
  }
  const user = await res.json();
  await mutate(SWR_KEYS.user, user, { revalidate: false });
  return user as AuthUser;
}

export async function logoutMutate() {
  await fetch("/api/auth/logout", { method: "POST" });
  await mutate(SWR_KEYS.user, null, { revalidate: false });
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

interface WorkspacesResponse {
  workspaces: Workspace[];
}

const EMPTY_WORKSPACES: Workspace[] = [];

// Workspaces now live entirely in the localStorage-backed zustand store
// (useWorkspaceStore). The remote /api/sandbox/list endpoint is gone, so this
// hook reads the store instead of SWR-fetching. Signature is unchanged.
export function useWorkspaces(enabled = true) {
  const workspaces = useWorkspaceStore((s) =>
    enabled ? s.workspaces : EMPTY_WORKSPACES,
  );
  return {
    workspaces: workspaces ?? EMPTY_WORKSPACES,
    isLoading: false,
    isValidating: false,
    error: undefined as Error | undefined,
  };
}

// No-op: there is no remote workspace list to revalidate. Callers `void` this.
export async function mutateWorkspaces() {
  return undefined;
}

// ---------------------------------------------------------------------------
// Single workspace + sandbox info
// ---------------------------------------------------------------------------

interface WorkspaceResponse {
  workspace: Workspace;
  sandbox: SandboxInfo | null;
  sandboxLost?: boolean;
  canRecover?: boolean;
}

// Reads the single workspace + its in-page sandbox info from the local store.
// In-page sandboxes never get "lost" remotely, so sandboxLost/canRecover are
// always false. The remote /api/sandbox/${id} endpoint is gone.
export function useWorkspace(id: string | null) {
  const workspace = useWorkspaceStore((s) =>
    id ? s.workspaces.find((w) => w.id === id) ?? null : null,
  );
  const sandbox = useWorkspaceStore((s) => (id ? s.sandboxes[id] ?? null : null));
  return {
    workspace,
    sandbox,
    sandboxLost: false,
    canRecover: false,
    isLoading: false,
    error: undefined as Error | undefined,
  };
}

// No-op: workspace state is local; nothing remote to revalidate.
export async function mutateWorkspace(_id: string) {
  void _id;
  return undefined;
}

// ---------------------------------------------------------------------------
// Window state
// ---------------------------------------------------------------------------

interface WindowsResponse {
  windows: unknown[];
}

// Window layout is no longer fetched from a remote endpoint; it is kept in the
// window store (in-memory + localStorage). This hook returns empty state so the
// shell falls back to its first-boot behavior without any network call.
export function useWindowState(workspaceId: string | null) {
  void workspaceId;
  return {
    windows: null as unknown[] | null,
    isLoading: false,
    error: undefined as Error | undefined,
  };
}

// ---------------------------------------------------------------------------
// Desktop entries (from sandbox services, not Next.js API)
// ---------------------------------------------------------------------------

interface DesktopEntriesResponse {
  entries: DesktopEntry[];
  desktopShortcuts: DesktopEntry[];
  apps: DesktopEntry[];
}

export function useDesktopEntries(servicesDomain: string | null) {
  const { data, error, isLoading } = useSWRImmutable<DesktopEntriesResponse>(
    servicesDomain ? SWR_KEYS.desktopEntries(servicesDomain) : null,
    sandboxServiceFetcher,
  );
  return { data: data ?? null, isLoading, error: error as Error | undefined };
}

// ---------------------------------------------------------------------------
// File manager directory listing
// ---------------------------------------------------------------------------

interface DirectoryListingResponse {
  items: FileEntry[];
}

interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
}

export function useDirectoryListing(
  servicesDomain: string | null,
  path: string,
) {
  const key =
    servicesDomain ? SWR_KEYS.directoryListing(servicesDomain, path) : null;
  const { data, error, isLoading, isValidating, mutate: revalidate } =
    useSWR<DirectoryListingResponse>(key, sandboxServiceFetcher, {
      revalidateOnFocus: false,
      dedupingInterval: 1000,
    });
  return {
    entries: data?.items ?? [],
    isLoading,
    isValidating,
    error: error as Error | undefined,
    revalidate,
  };
}


