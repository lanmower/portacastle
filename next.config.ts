import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**.vercel.sh",
      },
    ],
    dangerouslyAllowSVG: true,
  },
  serverExternalPackages: ["@vercel/sandbox"],
  async headers() {
    return [
      {
        // Cross-origin isolation is mandatory for SharedArrayBuffer, which the
        // threaded (-pthread) blinkenlib.wasm needs for its pthread worker pool.
        // Applied site-wide so the in-page sandbox can spin SAB-backed threads.
        // Every subresource must then be CORP/CORS-compatible (see
        // sec-coep-subresources): same-origin assets are fine, cross-origin
        // ones need crossorigin attrs or a proxy.
        source: "/:path*",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
      {
        // The WASM + glue + rootfs assets are served from /containers. Mark them
        // cross-origin-resource-policy compatible and long-cache them (they are
        // content-addressed by the build sha in the commit message; the bytes
        // for a given filename are immutable per deploy).
        source: "/containers/:path*",
        headers: [
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
    ];
  },
};

export default nextConfig;
