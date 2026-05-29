"use client";

/**
 * Heartbeat is a no-op now.
 *
 * This hook used to POST /api/sandbox/${id}/extend on an interval to keep a
 * remote Vercel sandbox VM alive. The remote-VM backend is gone: in-page
 * portabox sandboxes live in the browser tab and never expire, so there is
 * nothing to keep alive. Kept as an exported no-op so existing callers (e.g.
 * desktop-shell) keep compiling and rendering without any network calls.
 */
export function useSandboxHeartbeat() {
  // Intentionally empty: no remote sandbox to extend.
}
