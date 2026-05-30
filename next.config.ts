import type { NextConfig } from "next";

// Static export mode (GitHub Pages). When NEXT_PUBLIC_STATIC_EXPORT=1 the app is
// built as a fully static, server-less site: no /api routes, no server session —
// it boots straight into the DB-less guest desktop and runs entirely in-page via
// the blink WASM sandbox. GitHub Pages serves a project page under a subpath
// (/<repo>/), so basePath/assetPrefix are set from NEXT_PUBLIC_BASE_PATH.
const isStaticExport = process.env.NEXT_PUBLIC_STATIC_EXPORT === "1";
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  // Pin the workspace root to this project so Next doesn't walk up to a stray
  // parent lockfile (a C:\package-lock.json was being inferred as the root).
  turbopack: {
    root: import.meta.dirname,
  },
  images: {
    // GitHub Pages has no Image Optimization server.
    unoptimized: isStaticExport,
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**.vercel.sh",
      },
    ],
    dangerouslyAllowSVG: true,
  },
  // portabox/webix carry a Node host branch (node:fs) used only under Node;
  // keep them external on the server so the bundler never inlines that path.
  serverExternalPackages: ["portabox", "webix"],
  ...(isStaticExport
    ? {
        output: "export" as const,
        basePath: basePath || undefined,
        assetPrefix: basePath || undefined,
        // Pages serves /path/ as /path/index.html; trailing slashes keep links
        // resolving under the project subpath.
        trailingSlash: true,
      }
    : {
        async headers() {
          return [
            {
              // Cross-origin isolation is mandatory for SharedArrayBuffer, which
              // the threaded (-pthread) blinkenlib.wasm needs for its pthread
              // worker pool. Applied site-wide so the in-page sandbox can spin
              // SAB-backed threads. Every subresource must then be CORP/CORS
              // compatible. (Static export can't send headers; the
              // coi-serviceworker shim injects these client-side on GH Pages.)
              source: "/:path*",
              headers: [
                { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
                { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
              ],
            },
            {
              // The WASM + glue + rootfs assets are served from /containers. Mark
              // them CORP-compatible and long-cache them (content-addressed by
              // the build sha; bytes for a given filename are immutable per deploy).
              source: "/containers/:path*",
              headers: [
                { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
                { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
              ],
            },
          ];
        },
      }),
};

export default nextConfig;
