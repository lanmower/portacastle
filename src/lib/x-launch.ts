/**
 * In-page X application launcher.
 *
 * Replaces the original sandcastle xpra launcher (which targeted a remote VM +
 * an xpra connection, both removed in the in-page rewire). An app is launched
 * as a real X client against the in-page Xvfb under blink: lay the X stack
 * (patched Xvfb + precompiled keymap + the client/lib overlay) into the guest
 * FS, then run the server + the named client concurrently via
 * sandbox.runConcurrent. No server, no network.
 *
 * One-shot semantics today: runConcurrent returns when the client exits (or the
 * timeout fires). A persistent X server with live windows is a follow-up
 * (worker-scheduling); this is the shared launch primitive the App Store + dock
 * entries call.
 */

import { useClientSandboxStore } from "@/stores/client-sandbox-store";
import { asset } from "@/lib/static-export";

const CONTAINERS = asset("/containers");
const DISPLAY = ":99";

interface Fs {
  mkdir(path: string): void;
  unlink(path: string): void;
  open(path: string, flags: string): number;
  write(fd: number, buf: Uint8Array, offset: number, length: number, position: number): number;
  close(fd: number): void;
  chmod(path: string, mode: number): void;
  stat(path: string): unknown;
}

interface TarEntry { path: string; data: Uint8Array; isDir: boolean }

async function fetchBytes(url: string): Promise<Uint8Array> {
  // no-store so a rebuilt Xvfb-patched / overlay / keymap is picked up on reload
  // instead of a stale HTTP-cached copy (matches the GUI/X-apps ELF fetches).
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function gunzip(gz: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("gzip");
  const stream = new Response(new Blob([gz as BlobPart]).stream().pipeThrough(ds));
  return new Uint8Array(await stream.arrayBuffer());
}

/** Minimal ustar/GNU/PAX reader (symlink-free overlay -> dirs + files only). */
function readTar(buf: Uint8Array): TarEntry[] {
  const td = new TextDecoder();
  const str = (o: number, l: number) => td.decode(buf.subarray(o, o + l)).replace(/\0.*$/, "");
  const size = (o: number) => {
    if (buf[o] & 0x80) { let n = 0; for (let i = o + 1; i < o + 12; i++) n = n * 256 + buf[i]; return n; }
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

/** Read the live emscripten MEMFS off the runExclusive Sandbox handle. */
function liveFs(sb: unknown): Fs | null {
  return (
    (sb as { _client?: { host?: { core?: { Module?: { FS?: Fs } } } } })
      ?._client?.host?.core?.Module?.FS ?? null
  );
}

const xStackLaid = new WeakSet<object>();

/** Lay the X server + keymap + client/lib overlay into the guest FS (once per sandbox). */
async function ensureXStack(sb: unknown): Promise<void> {
  if (xStackLaid.has(sb as object)) return;
  const fs = liveFs(sb);
  if (!fs) throw new Error("x-launch: live guest FS unavailable");
  // Already laid (e.g. by the X Apps app)?
  try { fs.stat("/usr/bin/Xvfb"); xStackLaid.add(sb as object); return; } catch { /* lay it */ }
  const [overlay, xvfb, xkm] = await Promise.all([
    fetchBytes(`${CONTAINERS}/x-client-overlay.tar.gz`),
    fetchBytes(`${CONTAINERS}/Xvfb-patched`),
    fetchBytes(`${CONTAINERS}/server.xkm`),
  ]);
  const entries = readTar(await gunzip(overlay));
  const mkdirp = (p: string) => {
    let cur = "";
    for (const seg of p.split("/").filter(Boolean)) { cur += "/" + seg; try { fs.mkdir(cur); } catch { /* exists */ } }
  };
  const writeFile = (path: string, content: Uint8Array) => {
    const dir = path.replace(/\/[^/]*$/, "");
    if (dir) mkdirp(dir);
    try { fs.unlink(path); } catch { /* new */ }
    const fd = fs.open(path, "w+");
    if (content.length) fs.write(fd, content, 0, content.length, 0);
    fs.close(fd);
    try { fs.chmod(path, 0o755); } catch { /* best effort */ }
  };
  for (const e of entries) if (!e.isDir) writeFile(e.path, e.data);
  writeFile("/usr/bin/Xvfb", xvfb);
  for (const d of ["/tmp", "/var/lib/xkb", "/usr/share/X11/xkb/compiled", ""]) {
    for (const n of ["server-99.xkm", "server-98.xkm", "server-0.xkm"]) writeFile(`${d}/${n}`, xkm);
  }
  mkdirp("/tmp/.X11-unix");
  xStackLaid.add(sb as object);
}

export interface XLaunchResult {
  exitCode: number | string;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Launch `command` (an installed binary name or absolute path, plus argv) as an
 * X client against the in-page Xvfb. Serialized through the workspace's single
 * VM via runExclusive. Resolves with the client's exit + output.
 */
export async function launchXApp(
  workspaceId: string,
  command: string,
  argv: string[] = [],
): Promise<XLaunchResult> {
  const runExclusive = useClientSandboxStore.getState().runExclusive;
  // Dev handle: expose the launcher + the client-sandbox store on window.__sc so
  // the live page (and browser-witness) can drive a launch directly.
  if (typeof window !== "undefined") {
    const w = window as unknown as { __sc?: Record<string, unknown> };
    w.__sc = w.__sc || {};
    w.__sc.launchXApp = launchXApp;
    w.__sc.clientSandbox = useClientSandboxStore;
  }
  const ensureSandbox = useClientSandboxStore.getState().ensureSandbox;
  const path = command.startsWith("/") ? command : `/usr/bin/${command}`;

  // Auto-install via apk if the binary is not present in the guest FS (so a dock
  // entry for a not-yet-installed app installs-then-launches). This runs OUTSIDE
  // runExclusive: pkgInstall is host-orchestrated (CORS-proxy fetch + extract into
  // the guest MEMFS) and needs no VM exclusivity. Holding the per-workspace VM
  // lock during the install would serialize it behind any in-flight X run (a
  // forever client like xeyes holds the lock for its whole overallTimeout), which
  // makes a perfectly healthy ~4s install look like a multi-minute hang. The lock
  // is acquired only for the runConcurrent below, which is the part that needs it.
  // Publish a per-workspace install-status string the X window overlay reads, so
  // a not-yet-installed launch shows "Installing <pkg>..." (or a precise error)
  // instead of a silent connecting/black window while the apk fetch runs.
  const setInstallStatus = (msg: string | null) => {
    if (typeof window === "undefined") return;
    const w = window as unknown as { __sc?: Record<string, unknown> };
    w.__sc = w.__sc || {};
    const byWs = ((w.__sc.xinstallByWorkspace ??= {}) as Record<string, string | null>);
    byWs[workspaceId] = msg;
  };

  const sb = await ensureSandbox(workspaceId);
  await ensureXStack(sb);
  const fs = liveFs(sb);
  let present = false;
  try { fs?.stat(path); present = true; } catch { present = false; }
  if (!present && !command.startsWith("/")) {
    const apkSb = sb as { pkgInstall?: (n: string) => Promise<unknown> };
    if (apkSb.pkgInstall) {
      setInstallStatus(`Installing ${command} (apk)...`);
      try {
        await apkSb.pkgInstall(command);
      } catch (err) {
        // Install genuinely failed (package not found, or every CORS proxy
        // unreachable). Surface it precisely instead of falling through to a
        // runConcurrent that execs a still-missing binary and reports a confusing
        // generic client failure.
        const msg = err instanceof Error ? err.message : String(err);
        setInstallStatus(`apk install failed: ${msg}`);
        return { exitCode: "apk-install-failed", stdout: "", stderr: msg, timedOut: false };
      }
      // Re-check presence after the install; a resolved-but-empty install (e.g. a
      // metapackage providing no binary at this path) is also a clear failure.
      try { fs?.stat(path); present = true; } catch { present = false; }
      if (!present) {
        const msg = `apk installed '${command}' but ${path} is not present`;
        setInstallStatus(msg);
        return { exitCode: "apk-install-failed", stdout: "", stderr: msg, timedOut: false };
      }
      // Installed + present: clear the status so the overlay returns to the
      // normal connecting/running display for the run that follows.
      setInstallStatus(null);
    }
  }

  return runExclusive(workspaceId, async () => {
    // Clear any stale X server socket + lock left by a PRIOR server VM that
    // exited without cleanup (e.g. a previous run that crashed, or a forever
    // client whose server thread died). A leftover /tmp/.X11-unix/X99 or
    // /tmp/.X99-lock makes the fresh Xvfb fatal-exit with
    // "_XSERVTransMakeAllCOTSServerListeners: server already running /
    // Cannot establish any listening sockets" (witnessed: a 2nd launch on a
    // dirty :99 dies at slot0). runExclusive guarantees no LIVE server holds
    // :99 here (a concurrent launch is serialized behind us), so anything at
    // these paths is stale and safe to remove before binding.
    const xfs = liveFs(sb);
    if (xfs) {
      const dpyNum = DISPLAY.replace(":", "");
      for (const stale of [`/tmp/.X11-unix/X${dpyNum}`, `/tmp/.X${dpyNum}-lock`]) {
        try { xfs.stat(stale); try { xfs.unlink(stale); } catch { /* best effort */ } }
        catch { /* absent — nothing to clear */ }
      }
    }
    // Proven single-call model: run the Xvfb server + the X client CONCURRENTLY
    // in one runConcurrent (slot0 server + slot1 client over the in-process
    // AF_UNIX layer) -- the path proven to connect + paint (X Apps/xdpyinfo,
    // xsetroot). The separate startXServer/launchXClient persistent split wedged
    // (client never painted) and collided on display :99, so it is retired here.
    // The patched Xvfb publishes its screen framebuffer via 0x5fb every dispatch
    // cycle; the XWindowCanvas blits fbView() (RGB565->RGBA) on rAF DURING this
    // run, so the window is live while the client runs. For a forever client
    // (xclock/xeyes) the run sits until overallTimeout; the canvas keeps
    // sampling the live framebuffer meanwhile (the server paints on its own
    // worker thread). One X server per sandbox: a single in-flight launch owns
    // :99 (serialized by runExclusive).
    const xsb = sb as {
      runConcurrent: (
        server: { path: string; argv?: string[] },
        client: { path: string; argv?: string[]; progname?: string },
        opts?: { clientDelayMs?: number; overallTimeoutMs?: number },
      ) => Promise<{ timedOut: boolean; client: { exitCode: number | string; stdout: string; stderr: string } }>;
    };
    const r = await xsb.runConcurrent(
      { path: "/usr/bin/Xvfb", argv: [DISPLAY, "-screen", "0", "800x600x16", "-ac", "-noreset", "-nolock"] },
      { path, progname: path, argv: ["-display", DISPLAY, ...argv] },
      { clientDelayMs: 4000, overallTimeoutMs: 90000 },
    );
    return {
      exitCode: r.client.exitCode,
      stdout: r.client.stdout || "",
      stderr: r.client.stderr || "",
      timedOut: r.timedOut,
    };
  });
}
