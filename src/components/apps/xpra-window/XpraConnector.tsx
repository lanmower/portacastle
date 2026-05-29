"use client";

// The remote Xpra server (reached via sandbox.domains.xpra) is gone. The
// desktop now renders entirely in-page through DesktopCanvas, which uses
// sandbox.attachDisplay over the in-page framebuffer.
// See: src/components/apps/desktop-canvas/DesktopCanvas.tsx
//
// This component is kept as a no-op so existing importers continue to compile.
export function XpraConnector() {
  return null;
}
