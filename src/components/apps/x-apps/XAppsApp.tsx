"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useActiveSandbox } from "@/stores/workspace-store";
import { useClientSandboxStore } from "@/stores/client-sandbox-store";
import { NoWorkspacePlaceholder } from "@/components/apps/no-workspace-placeholder";
import { asset } from "@/lib/static-export";

/**
 * X Apps: runs a REAL X server (Xvfb) and a REAL X client (xdpyinfo) entirely
 * in-page under the blink WASM emulator -- no server, no network. The two guests
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

const CONTAINERS = asset("/containers");
const DISPLAY = ":99";

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { cache: "force-cache" });
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Gunzip in-browser so we never rely on the guest forking a gzip child. */
async function gunzip(gz: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("gzip");
  const stream = new Response(new Blob([gz as BlobPart]).stream().pipeThrough(ds));
  return new Uint8Array(await stream.arrayBuffer());
}

interface TarEntry { path: string; data: Uint8Array; isDir: boolean }

/** Minimal emscripten MEMFS surface used for the direct overlay write. */
interface Fs {
  mkdir(path: string): void;
  unlink(path: string): void;
  open(path: string, flags: string): number;
  write(fd: number, buf: Uint8Array, offset: number, length: number, position: number): number;
  close(fd: number): void;
  chmod(path: string, mode: number): void;
}

/**
 * Minimal ustar/GNU/PAX reader. The overlay is symlink-free (SONAMEs are real
 * files), so we only emit dirs + regular files. We parse in JS rather than
 * shelling out to busybox tar because busybox `tar -z` forks (unsupported under
 * blink) and its extractor aborts on PAX/GNU header records.
 */
function readTar(buf: Uint8Array): TarEntry[] {
  const td = new TextDecoder();
  const str = (o: number, l: number) => td.decode(buf.subarray(o, o + l)).replace(/\0.*$/, "");
  const size = (o: number) => {
    // Octal, or GNU base-256 when the high bit of the first byte is set.
    if (buf[o] & 0x80) {
      let n = 0;
      for (let i = o + 1; i < o + 12; i++) n = n * 256 + buf[i];
      return n;
    }
    return parseInt(str(o, 12).trim() || "0", 8);
  };
  const out: TarEntry[] = [];
  let off = 0;
  let pending: string | null = null;
  let zeros = 0;
  while (off + 512 <= buf.length) {
    let allZero = true;
    for (let i = 0; i < 512; i++) if (buf[off + i] !== 0) { allZero = false; break; }
    if (allZero) { if (++zeros >= 2) break; off += 512; continue; }
    zeros = 0;
    let name = str(off, 100);
    const sz = size(off + 124);
    const type = String.fromCharCode(buf[off + 156] || 48);
    const body = buf.subarray(off + 512, off + 512 + sz);
    const adv = 512 + Math.ceil(sz / 512) * 512;
    if (type === "L") { pending = td.decode(body).replace(/\0.*$/, ""); off += adv; continue; }
    if (type === "x" || type === "g") {
      const m = td.decode(body).match(/\d+ path=([^\n]+)\n/);
      if (m) pending = m[1];
      off += adv;
      continue;
    }
    const prefix = str(off + 345, 155);
    if (pending) { name = pending; pending = null; }
    else if (prefix) name = prefix + "/" + name;
    off += adv;
    if (!name) continue;
    const path = "/" + name.replace(/^\.?\/*/, "").replace(/\/$/, "");
    if (type === "5") out.push({ path, data: new Uint8Array(0), isDir: true });
    else if (type === "0" || type === "\0" || type === "" || type === "7")
      out.push({ path, data: new Uint8Array(body), isDir: false });
  }
  return out;
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
    // Live diagnostic: timestamped phase log readable from the browser via
    // window.__xappdbg, plus the client-sandbox store handle. TEMP (worker-
    // scheduling diagnosis of the in-browser runConcurrent hang).
    const t0 = Date.now();
    const dbg: string[] = [];
    const mark = (s: string) => { dbg.push(`+${Date.now() - t0}ms ${s}`); };
    (window as unknown as { __xappdbg: string[] }).__xappdbg = dbg;
    (window as unknown as { __sc?: Record<string, unknown> }).__sc =
      (window as unknown as { __sc?: Record<string, unknown> }).__sc || {};
    (window as unknown as { __sc: Record<string, unknown> }).__sc.clientSandbox = useClientSandboxStore;
    try {
      mark("fetch containers start");
      const [overlay, xvfb, xkm] = await Promise.all([
        fetchBytes(`${CONTAINERS}/x-client-overlay.tar.gz`),
        fetchBytes(`${CONTAINERS}/Xvfb-patched`),
        fetchBytes(`${CONTAINERS}/server.xkm`),
      ]);

      // Gunzip + parse the overlay in the browser (busybox `tar -z` forks, and
      // its extractor aborts on PAX headers under blink), then write each entry
      // straight into the guest FS.
      mark("containers fetched");
      const entries = readTar(await gunzip(overlay));
      mark(`overlay parsed (${entries.length} entries)`);

      // Build ONE batch of files: the whole overlay (libs + binaries), the
      // patched X server, and the precompiled keymap at every plausible XKB
      // output dir. writeFiles streams them into the guest FS in a single VM
      // interaction (auto-creating dirs) -- per-file runCommand("chmod"/mkdir)
      // over ~700 files would spawn the VM hundreds of times and hang the page.
      const batch: { path: string; content: Uint8Array }[] = [];
      for (const e of entries) if (!e.isDir) batch.push({ path: e.path, content: e.data });
      batch.push({ path: "/usr/bin/Xvfb", content: xvfb });
      for (const d of ["/tmp", "/var/lib/xkb", "/usr/share/X11/xkb/compiled", ""]) {
        for (const n of ["server-99.xkm", "server-0.xkm"]) {
          batch.push({ path: `${d}/${n}`, content: xkm });
        }
      }
      // Create /tmp/.X11-unix by writing a placeholder into it via the batch
      // (writeFiles auto-creates parent dirs). Avoids a serial runCommand("mkdir")
      // which was wedging the per-workspace run chain before runConcurrent.
      batch.push({ path: "/tmp/.X11-unix/.keep", content: new Uint8Array(0) });

      mark(`batch built (${batch.length} files); entering runExclusive`);
      const result = await runExclusive<{
        timedOut: boolean;
        client: { exitCode: number | string; stdout: string; stderr: string };
        server: { exitCode: number | string; stdout: string; stderr: string };
      }>(activeWorkspaceId, async (sb) => {
        mark("runExclusive: writeFiles start");
        // Write the overlay straight into the live guest MEMFS. The high-level
        // sb.writeFiles did not land files in the in-browser path (they were
        // missing from the FS runConcurrent reads -> ENOENT). The emscripten FS
        // open/write/close is synchronous + coherent (this is exactly how the
        // CI XO-smoke lays the overlay). Reach the host FS via the internal
        // handle; fall back to sb.writeFiles if the shape ever changes.
        const fsApi =
          (sb as unknown as { _client?: { host?: { core?: { Module?: { FS?: Fs } } } } })
            ?._client?.host?.core?.Module?.FS;
        if (fsApi) {
          const mkdirp = (p: string) => {
            let cur = "";
            for (const seg of p.split("/").filter(Boolean)) {
              cur += "/" + seg;
              try { fsApi.mkdir(cur); } catch { /* exists */ }
            }
          };
          for (const f of batch) {
            const dir = f.path.replace(/\/[^/]*$/, "");
            if (dir) mkdirp(dir);
            try { fsApi.unlink(f.path); } catch { /* new */ }
            const fd = fsApi.open(f.path, "w+");
            if (f.content.length) fsApi.write(fd, f.content, 0, f.content.length, 0);
            fsApi.close(fd);
            try { fsApi.chmod(f.path, 0o755); } catch { /* best effort */ }
          }
        } else {
          await sb.writeFiles(batch);
        }
        mark(`writeFiles done (direct=${!!fsApi})`);
        // Make the binaries executable (a handful of runCommand calls, not 700).
        await sb.runCommand("chmod", ["0755", "/usr/bin/Xvfb", "/usr/bin/xdpyinfo", "/usr/bin/xsetroot"]).catch(() => {});
        mark("chmod done; runConcurrent start");
        // Run the real X server + a real X client concurrently, in-page.
        const rc = await sb.runConcurrent(
          {
            path: "/usr/bin/Xvfb",
            argv: [DISPLAY, "-screen", "0", "640x480x16", "-ac", "-noreset", "-nolock"],
          },
          { path: "/usr/bin/xdpyinfo", argv: ["-display", DISPLAY] },
          { clientDelayMs: 4000, overallTimeoutMs: 90000 },
        );
        mark(`runConcurrent returned: client exit ${rc.client.exitCode} timedOut ${rc.timedOut}`);
        return rc;
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

  // Auto-run once when the app opens for a workspace. Defer the kick to a
  // microtask so run()'s opening setStatus() does not fire synchronously inside
  // the effect body (which would trigger a cascading render).
  useEffect(() => {
    if (!activeWorkspaceId || ran.current) return;
    ran.current = true;
    queueMicrotask(() => void run());
  }, [activeWorkspaceId, run]);

  if (!activeWorkspaceId) return <NoWorkspacePlaceholder message="Open a workspace to run X apps" />;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", padding: 12, gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <strong>X Apps -- real Xvfb + xdpyinfo, in-page</strong>
        <button onClick={() => void run()} disabled={status === "running"}>
          {status === "running" ? "Running..." : "Re-run"}
        </button>
        <span style={{ opacity: 0.7 }}>
          {status === "running" && "starting X server + client..."}
          {status === "done" && "[ok] X client connected to in-page Xvfb"}
          {status === "error" && "[fail] failed"}
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
