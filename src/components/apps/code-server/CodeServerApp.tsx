"use client";

import { useActiveSandbox } from "@/stores/workspace-store";
import { NoWorkspacePlaceholder } from "@/components/apps/no-workspace-placeholder";

export function CodeServerApp({ meta: _meta }: { meta?: Record<string, unknown> }) {
  const { activeWorkspaceId } = useActiveSandbox();

  if (!activeWorkspaceId) {
    return (
      <NoWorkspacePlaceholder message="No active workspace. Create one to use Code." />
    );
  }

  // The remote code-server (served over a port via sandbox.domains.codeServer)
  // no longer exists — everything runs in-page via portabox. The planned
  // replacement is an in-page Monaco/CodeMirror editor backed by sandbox.fs,
  // which is not yet wired up.
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center text-gray-900">
      <div className="text-sm font-medium text-gray-1000">In-browser editor</div>
      <p className="max-w-md text-sm text-gray-900">
        This editor is backed by the in-page sandbox filesystem. The previous
        code-server-over-a-port integration is no longer used. An in-page editor
        (Monaco/CodeMirror over <code>sandbox.fs</code>) is planned but not yet
        wired up.
      </p>
    </div>
  );
}
