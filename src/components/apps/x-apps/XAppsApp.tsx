"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useActiveSandbox } from "@/stores/workspace-store";
import { useClientSandboxStore } from "@/stores/client-sandbox-store";
import { NoWorkspacePlaceholder } from "@/components/apps/no-workspace-placeholder";

/**
 * X Apps: runs a REAL X server (Xvfb) and a REAL X client (xdpyinfo) entirely
 * in-page under the blink WASM emulator — no server, no network. The two guests
 * run on their own worker pthreads and talk over blink's in-process AF_UNIX
 * layer; this is the same path proven by the webix XC-smoke CI witness.
 *
 * The X stack is bundled as same-origin containers:
 *   - Xvfb-patched         : GL-less xorg-server 21.1.16, no-fork keymap
 *   - server.xkm           : precompiled XKB keymap (server reads it, no xkbcomp)
 *   - x-client-overlay.tar.gz : xdpyinfo + xsetroot + their musl .so closure
 *
 * On run we layer the overlay into the guest FS, place Xvfb + the keymap, create
 * /tmp/.X11-unix, then runConcurrent(Xvfb, xdpyinfo) and show xdpyinfo's output.
 */

const CONTAINERS = "/containers";
const DISPLAY = ":99";

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { cache: "force-cache" });
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export function XAppsApp() {
  const { activeWorkspaceId } = useActiveSandbox();
  const runExclusive = useClientSandboxStore((s) => s.runExclusive);
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [output, setOutput] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const ran = useRef(false);

  const run = useCallback(async () => {
    if (!activeWorkspaceId) return;
    setStatus("running");
    setErr(null);
    setOutput("");
    try {
      const [overlay, xvfb, xkm] = await Promise.all([
        fetchBytes(`${CONTAINERS}/x-client-overlay.tar.gz`),
        fetchBytes(`${CONTAINERS}/Xvfb-patched`),
        fetchBytes(`${CONTAINERS}/server.xkm`),
      ]);

      const result = await runExclusive(activeWorkspaceId, async (sb) => {
        // 1) Lay the X-client + its shared-library closure into the guest FS.
        await sb.fs.writeFile("/x-client-overlay.tar.gz", overlay);
        const untar = await sb.runCommand("tar", ["-xzf", "/x-client-overlay.tar.gz", "-C", "/"]);
        if (untar.exitCode !== 0) {
          throw new Error(`overlay extract failed: ${untar.stderr || untar.stdout}`);
        }
        // 2) Place the patched X server + precompiled keymap where dix reads them.
        await sb.fs.writeFile("/usr/bin/Xvfb", xvfb);
        await sb.runCommand("chmod", ["0755", "/usr/bin/Xvfb"]);
        await sb.runCommand("mkdir", ["-p", "/tmp/.X11-unix"]);
        // The patched RunXkbComp returns the keymap NAME; dix LoadXKM-reads
        // <outdir>/server-<n>.xkm. Place it under both common spellings.
        for (const p of [`/tmp/server-99.xkm`, `/tmp/server-0.xkm`]) {
          await sb.fs.writeFile(p, xkm);
        }
        // 3) Run the real X server + a real X client concurrently, in-page.
        return sb.runConcurrent(
          {
            path: "/usr/bin/Xvfb",
            argv: [DISPLAY, "-screen", "0", "640x480x16", "-ac", "-noreset", "-nolock"],
          },
          { path: "/usr/bin/xdpyinfo", argv: ["-display", DISPLAY] },
          { clientDelayMs: 4000, overallTimeoutMs: 90000 },
        );
      });

      const out = result.client.stdout || "";
      setOutput(out);
      const ok =
        result.client.exitCode === 0 ||
        /number of screens|dimensions:|X\.Org/i.test(out);
      setStatus(ok ? "done" : "error");
      if (!ok) setErr(`client exit ${result.client.exitCode}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, [activeWorkspaceId, runExclusive]);

  // Auto-run once when the app opens for a workspace.
  useEffect(() => {
    if (!activeWorkspaceId || ran.current) return;
    ran.current = true;
    void run();
  }, [activeWorkspaceId, run]);

  if (!activeWorkspaceId) return <NoWorkspacePlaceholder />;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", padding: 12, gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <strong>X Apps — real Xvfb + xdpyinfo, in-page</strong>
        <button onClick={() => void run()} disabled={status === "running"}>
          {status === "running" ? "Running…" : "Re-run"}
        </button>
        <span style={{ opacity: 0.7 }}>
          {status === "running" && "starting X server + client…"}
          {status === "done" && "✓ X client connected to in-page Xvfb"}
          {status === "error" && "✗ failed"}
        </span>
      </div>
      {err && <div style={{ color: "#c00", fontFamily: "monospace" }}>{err}</div>}
      <pre
        style={{
          flex: 1,
          margin: 0,
          overflow: "auto",
          background: "#0b0b0b",
          color: "#d6e7ff",
          padding: 10,
          fontSize: 12,
          lineHeight: 1.35,
          borderRadius: 6,
          whiteSpace: "pre-wrap",
        }}
      >
        {output || "(no output yet)"}
      </pre>
    </div>
  );
}
