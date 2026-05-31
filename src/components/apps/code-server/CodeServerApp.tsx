"use client";

import { useCallback, useState } from "react";
import { useActiveSandbox } from "@/stores/workspace-store";
import { useClientSandboxStore } from "@/stores/client-sandbox-store";
import { NoWorkspacePlaceholder } from "@/components/apps/no-workspace-placeholder";

/**
 * In-page code editor backed by the sandbox filesystem.
 *
 * The remote code-server-over-a-port integration is gone; everything runs
 * in-page via portabox. This is a dependency-free editor: open a path from the
 * in-page guest FS into a textarea, edit, and save back via sb.fs. A zero-dep
 * textarea (rather than Monaco/CodeMirror) keeps the bundle small and the
 * maintenance surface minimal while delivering read/edit/save over the real
 * guest filesystem.
 */
export function CodeServerApp({ meta: _meta }: { meta?: Record<string, unknown> }) {
  const { activeWorkspaceId } = useActiveSandbox();
  const runExclusive = useClientSandboxStore((s) => s.runExclusive);
  const [path, setPath] = useState("/root/notes.txt");
  const [doc, setDoc] = useState("");
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const open = useCallback(async () => {
    if (!activeWorkspaceId || busy) return;
    setBusy(true);
    setStatus("opening...");
    try {
      const text = await runExclusive(activeWorkspaceId, async (sb) => {
        try {
          return (await sb.fs.readFile(path, { encoding: "utf8" })) as string;
        } catch {
          return ""; // new file
        }
      });
      setDoc(text);
      setLoadedPath(path);
      setStatus(`opened ${path} (${text.length} bytes)`);
    } catch (e) {
      setStatus(`open failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [activeWorkspaceId, path, runExclusive, busy]);

  const save = useCallback(async () => {
    if (!activeWorkspaceId || busy) return;
    setBusy(true);
    setStatus("saving...");
    try {
      await runExclusive(activeWorkspaceId, async (sb) => {
        const dir = path.replace(/\/[^/]*$/, "");
        if (dir) await sb.fs.mkdir(dir, { recursive: true }).catch(() => {});
        await sb.fs.writeFile(path, doc);
      });
      setLoadedPath(path);
      setStatus(`saved ${path} (${doc.length} bytes)`);
    } catch (e) {
      setStatus(`save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [activeWorkspaceId, path, doc, runExclusive, busy]);

  if (!activeWorkspaceId) {
    return <NoWorkspacePlaceholder message="No active workspace. Create one to use Code." />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 8, padding: 10 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="/root/file.txt"
          spellCheck={false}
          style={{ flex: 1, fontFamily: "monospace", fontSize: 13, padding: "4px 8px" }}
        />
        <button onClick={() => void open()} disabled={busy}>Open</button>
        <button onClick={() => void save()} disabled={busy}>Save</button>
      </div>
      <textarea
        value={doc}
        onChange={(e) => setDoc(e.target.value)}
        spellCheck={false}
        data-loaded-path={loadedPath ?? ""}
        style={{
          flex: 1,
          fontFamily: "monospace",
          fontSize: 13,
          lineHeight: 1.45,
          padding: 8,
          resize: "none",
          background: "#0b0b0b",
          color: "#d6e7ff",
          border: "1px solid #333",
          borderRadius: 6,
          whiteSpace: "pre",
          overflow: "auto",
        }}
      />
      <div style={{ fontSize: 12, opacity: 0.75, fontFamily: "monospace" }}>{status}</div>
    </div>
  );
}
