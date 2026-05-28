"use client";

import useSWR from "swr";
import { useCallback } from "react";
import { useClientSandboxStore } from "@/stores/client-sandbox-store";

/**
 * In-page filesystem hook backed by the portabox sandbox's node:fs/promises-
 * compatible `fs`. Replaces the remote `/files/*` service + `/api/files/*`
 * proxy: directory listings and mutations go straight to the in-page guest
 * filesystem, no network.
 */

export interface SandboxFileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? dir + name : dir + "/" + name;
}

export function useSandboxFs(workspaceId: string | null, cwd: string) {
  const ensureSandbox = useClientSandboxStore((s) => s.ensureSandbox);

  const key = workspaceId ? ["sandbox-fs", workspaceId, cwd] : null;

  const { data, error, isLoading, isValidating, mutate } = useSWR(
    key,
    async () => {
      const sandbox = await ensureSandbox(workspaceId!);
      const dirents = await sandbox.fs.readdir(cwd, { withFileTypes: true });
      const entries: SandboxFileEntry[] = [];
      for (const d of dirents) {
        const path = joinPath(cwd, d.name);
        let size = 0;
        const isDirectory = d.isDirectory();
        if (!isDirectory) {
          try {
            const st = await sandbox.fs.stat(path);
            size = Number(st.size) || 0;
          } catch {
            size = 0;
          }
        }
        entries.push({ name: d.name, path, isDirectory, size });
      }
      return entries;
    },
    { revalidateOnFocus: false },
  );

  const revalidate = useCallback(() => mutate(), [mutate]);

  return {
    entries: data ?? [],
    isLoading,
    isValidating,
    error: error as Error | undefined,
    revalidate,
  };
}

/**
 * Imperative filesystem mutations against the in-page sandbox. Returns helpers
 * that map the old `/files/{write,mkdir,rename,delete}` service calls to
 * `sandbox.fs`.
 */
export function useSandboxFsMutations(workspaceId: string | null) {
  const ensureSandbox = useClientSandboxStore((s) => s.ensureSandbox);

  const writeFile = useCallback(
    async (path: string, content: string) => {
      const sandbox = await ensureSandbox(workspaceId!);
      await sandbox.fs.writeFile(path, content);
    },
    [ensureSandbox, workspaceId],
  );

  const mkdir = useCallback(
    async (path: string) => {
      const sandbox = await ensureSandbox(workspaceId!);
      await sandbox.fs.mkdir(path);
    },
    [ensureSandbox, workspaceId],
  );

  const rename = useCallback(
    async (oldPath: string, newPath: string) => {
      const sandbox = await ensureSandbox(workspaceId!);
      await sandbox.fs.rename(oldPath, newPath);
    },
    [ensureSandbox, workspaceId],
  );

  const remove = useCallback(
    async (path: string, isDirectory: boolean) => {
      const sandbox = await ensureSandbox(workspaceId!);
      if (isDirectory) {
        await sandbox.fs.rm(path, { recursive: true, force: true });
      } else {
        await sandbox.fs.unlink(path);
      }
    },
    [ensureSandbox, workspaceId],
  );

  return { writeFile, mkdir, rename, remove };
}
