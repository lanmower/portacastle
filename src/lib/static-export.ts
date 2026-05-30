/**
 * Static-export (GitHub Pages) build helpers.
 *
 * When the app is built with NEXT_PUBLIC_STATIC_EXPORT=1 it ships as a fully
 * static, server-less site: no /api routes, no DB, no server session. It boots
 * straight into the DB-less guest desktop and runs entirely in-page via the
 * blink WASM sandbox. These helpers let shared code branch on that mode and
 * resolve asset URLs under the Pages project subpath (NEXT_PUBLIC_BASE_PATH).
 */

/** True when this build targets the static (GitHub Pages) export. */
export const IS_STATIC_EXPORT =
  process.env.NEXT_PUBLIC_STATIC_EXPORT === "1";

/** Project base path (e.g. "/portacastle") for assets, or "" in server mode. */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/**
 * Prefix an absolute, root-relative app path with the deploy base path so it
 * resolves under the GitHub Pages project subpath. No-op (returns the path
 * unchanged) in server mode where BASE_PATH is "".
 *
 *   asset("/containers/blinkenlib.wasm") -> "/portacastle/containers/blinkenlib.wasm"
 */
export function asset(path: string): string {
  if (!BASE_PATH) return path;
  if (!path.startsWith("/")) return path;
  // Avoid double-prefixing if already absolute under the base path.
  if (path === BASE_PATH || path.startsWith(BASE_PATH + "/")) return path;
  return BASE_PATH + path;
}

/** The synthetic guest session used by the static build (no DB row). */
export const STATIC_GUEST_USER = {
  id: "static-guest",
  email: null as string | null,
  name: "Guest" as string | null,
  role: "guest" as const,
};
