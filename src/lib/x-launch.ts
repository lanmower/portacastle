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

const CONTAINERS = "/containers";
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
  return runExclusive(workspaceId, async (sb) => {
    await ensureXStack(sb);
    const path = command.startsWith("/") ? command : `/usr/bin/${command}`;
    // Auto-install via apk if the binary is not present in the guest FS (so a
    // dock entry for a not-yet-installed app installs-then-launches).
    const fs = liveFs(sb);
    let present = false;
    try { fs?.stat(path); present = true; } catch { present = false; }
    if (!present && !command.startsWith("/")) {
      const apkSb = sb as { pkgInstall?: (n: string) => Promise<unknown> };
      if (apkSb.pkgInstall) { try { await apkSb.pkgInstall(command); } catch { /* fall through; run may still fail */ } }
    }
    const xsb = sb as {
      xRunning: () => Promise<boolean>;
      startXServer: (server: { path: string; argv?: string[] }) => Promise<number>;
      launchXClient: (
        client: { path: string; argv?: string[]; progname?: string; timeoutMs?: number },
      ) => Promise<{ timedOut: boolean; exitCode: number | string; stdout: string; stderr: string }>;
    };
    // Persistent model: start the Xvfb server ONCE per sandbox (it keeps serving
    // and publishing its framebuffer via 0x5fb), then launch each app as a
    // client against it. The XWindowCanvas blits the live framebuffer meanwhile.
    if (!(await xsb.xRunning())) {
      await xsb.startXServer({
        path: "/usr/bin/Xvfb",
        // depth 16 (RGB565): the proven depth under blink (x24 did not register a
        // framebuffer). The host fbView() converts RGB565 -> RGBA for the canvas.
        argv: [DISPLAY, "-screen", "0", "800x600x16", "-ac", "-noreset", "-nolock"],
      });
      // Give the server a moment to reach its dispatch loop before the first
      // client connects (mirrors the proven runConcurrent clientDelay).
      await new Promise((r) => setTimeout(r, 4000));
    }
    const r = await xsb.launchXClient({
      path, progname: path, argv: ["-display", DISPLAY, ...argv], timeoutMs: 90000,
    });
    return {
      exitCode: r.exitCode,
      stdout: r.stdout || "",
      stderr: r.stderr || "",
      timedOut: r.timedOut,
    };
  });
}
