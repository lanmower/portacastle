/**
 * In-page sandbox handle.
 *
 * The remote-VM model exposed port-mapped `domains` (xpra/services/codeServer/
 * preview). The in-page portabox sandbox has no remote endpoints -- everything
 * runs in the page -- so `domains` is gone. `SandboxInfo` now just identifies the
 * live in-page sandbox bound to a workspace; the actual surface
 * (runCommand/fs/attachDisplay) is reached through the client-sandbox store.
 */
export interface SandboxInfo {
  sandboxId: string;
  status: string;
  /** Workspace id whose in-page portabox sandbox this handle refers to. */
  workspaceId: string;
  createdAt: string;
}

export interface SandboxCreateOptions {
  workspaceName?: string;
}
