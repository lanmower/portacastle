/**
 * Static (GitHub Pages) export build.
 *
 * `next build` with `output: "export"` refuses to build server-only routes
 * (the /api/* route handlers read cookies + DB; src/app/admin uses a server
 * session). The static site is guest-only and server-less, so those routes are
 * not part of it. Rather than mutate ~10 route files with force-static stubs,
 * this script temporarily relocates the server-only directories out of the app
 * tree, runs the export with NEXT_PUBLIC_STATIC_EXPORT=1, then ALWAYS restores
 * them (even on failure) so the working tree is never left mutated.
 *
 *   NEXT_PUBLIC_BASE_PATH=/portacastle node scripts/build-static.mjs
 */
import { execSync } from "node:child_process";
import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

// App subtrees that cannot exist in a static export (server handlers / session).
// We hide them by renaming IN PLACE to an underscore-prefixed sibling: the Next
// app router ignores `_`-prefixed folders, so they are excluded from the build,
// and an intra-directory rename is atomic + avoids the Windows EPERM seen when
// renaming a watched dir across directories.
const SERVER_ONLY = [
  { dir: "src/app/api", hidden: "src/app/_api_excluded" },
  { dir: "src/app/admin", hidden: "src/app/_admin_excluded" },
];

function stash() {
  for (const { dir, hidden } of SERVER_ONLY) {
    const src = join(ROOT, dir);
    const dst = join(ROOT, hidden);
    if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
    if (existsSync(src)) {
      renameSync(src, dst);
      console.log(`[build-static] hid ${dir}`);
    }
  }
}

function restore() {
  for (const { dir, hidden } of SERVER_ONLY) {
    const src = join(ROOT, hidden);
    const dst = join(ROOT, dir);
    if (existsSync(src) && !existsSync(dst)) {
      renameSync(src, dst);
      console.log(`[build-static] restored ${dir}`);
    }
  }
}

process.on("SIGINT", () => { restore(); process.exit(1); });
process.on("SIGTERM", () => { restore(); process.exit(1); });

let code = 0;
try {
  stash();
  // Drop any prior .next BEFORE building. Next's typed-routes typegen writes
  // .next/dev/types/validator.ts listing every route; a validator left over
  // from a dev session (or a prior build) still references /api + /admin, which
  // we just renamed away, so `next build`'s typecheck fails with
  // "Type '\"/admin\"' is not assignable to type '\"/\"'". Removing .next forces
  // typegen to regenerate against the excluded tree.
  rmSync(join(ROOT, ".next"), { recursive: true, force: true });
  // Resolve the local next bin (this script may run outside an npm-script PATH).
  const nextBin = join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "next.cmd" : "next");
  const cmd = existsSync(nextBin) ? `"${nextBin}" build` : "npx --no-install next build";
  execSync(cmd, {
    stdio: "inherit",
    shell: true,
    env: { ...process.env, NEXT_PUBLIC_STATIC_EXPORT: "1" },
  });
  // GitHub Pages runs Jekyll by default, which ignores files/dirs starting with
  // "_" (Next emits /_next/...). .nojekyll disables that so assets are served.
  const out = join(ROOT, "out");
  if (existsSync(out)) {
    writeFileSync(join(out, ".nojekyll"), "");
    console.log("[build-static] wrote out/.nojekyll");
  }
} catch (err) {
  console.error("[build-static] build failed:", err?.message ?? err);
  code = 1;
} finally {
  restore();
}
process.exit(code);
