import { create } from "zustand";
import type { DesktopEntry } from "@/types/desktop-entry";
import { asset } from "@/lib/static-export";

const BUILTIN_APPS: DesktopEntry[] = [
  {
    id: "terminal",
    name: "Terminal",
    icon: "/icons/dusk/terminal.svg",
    exec: null,
    type: "builtin",
    component: "terminal",
    categories: ["System"],
    comment: "Terminal emulator",
    onDesktop: true,
  },
  {
    id: "file-manager",
    name: "Files",
    icon: "/icons/dusk/finder2.svg",
    exec: null,
    type: "builtin",
    component: "file-manager",
    categories: ["System"],
    comment: "File manager",
    onDesktop: true,
  },
  {
    id: "code-server",
    name: "Code",
    icon: "/icons/dusk/vscode.svg",
    exec: null,
    type: "builtin",
    component: "code-server",
    categories: ["Development"],
    comment: "VS Code in the browser",
    onDesktop: true,
  },
  {
    id: "settings",
    name: "Settings",
    icon: "/icons/dusk/system_preferences.svg",
    exec: null,
    type: "builtin",
    component: "settings",
    categories: ["System"],
    comment: "Desktop settings",
    onDesktop: true,
  },
  {
    id: "app-store",
    name: "App Store",
    icon: "/icons/dusk/app_store.svg",
    exec: null,
    type: "builtin",
    component: "app-store",
    categories: ["System"],
    comment: "Browse and install apps",
    onDesktop: true,
  },
  {
    id: "gui-desktop",
    name: "GUI",
    icon: "/icons/dusk/system_preferences.svg",
    exec: null,
    type: "builtin",
    component: "gui-desktop",
    categories: ["System"],
    comment: "In-guest framebuffer GUI (xappdemo)",
    onDesktop: true,
  },
  {
    id: "x-apps",
    name: "X Apps",
    icon: "/icons/dusk/xeyes.svg",
    exec: null,
    type: "builtin",
    component: "x-apps",
    categories: ["System"],
    comment: "Real Xvfb + X client (xdpyinfo) in-page",
    onDesktop: true,
  },
  // The original sandcastle X11 apps: launched as X clients against the in-page
  // Xvfb (via useLaunchApp -> launchXApp). Missing binaries are apk-installed on
  // first launch. These mirror the classic X demo apps the App Store offered.
  {
    id: "xeyes",
    name: "xeyes",
    icon: "/icons/dusk/xeyes.svg",
    exec: "xeyes",
    type: "x11",
    component: null,
    categories: ["X11", "Utilities"],
    comment: "Eyes that follow the cursor",
    onDesktop: true,
  },
  {
    id: "xclock",
    name: "xclock",
    icon: "/icons/dusk/calendar.svg",
    exec: "xclock",
    type: "x11",
    component: null,
    categories: ["X11", "Utilities"],
    comment: "Analog/digital X clock",
    onDesktop: true,
  },
  {
    id: "xcalc",
    name: "xcalc",
    icon: "/icons/dusk/calculator.svg",
    exec: "xcalc",
    type: "x11",
    component: null,
    categories: ["X11", "Utilities"],
    comment: "Scientific calculator",
    onDesktop: true,
  },
  // xterm is intentionally NOT a dock app. Unlike xeyes/xclock/xcalc it is not
  // bundled in x-client-overlay.tar.gz, so launchXApp would fall through to the
  // apk-install path (Sandbox.pkgInstall -> Alpine repo over a CORS proxy). That
  // reaches an EXTERNAL service, which violates the standing in-page/no-external
  // constraint, and offline it simply hangs on "Installing xterm (apk)..."
  // (witnessed browser-798/800). The built-in Terminal app covers the terminal
  // need entirely in-page, so xterm is dropped from the dock rather than shipped
  // as a perpetually-installing entry.
];

// Base-path the builtin icon paths for the static (GitHub Pages) build. No-op
// in server mode. (getDuskIcon already base-paths the dynamically-resolved
// icons; this covers the literal icon paths on BUILTIN_APPS.)
const BUILTIN_APPS_BASED: DesktopEntry[] = BUILTIN_APPS.map((a) => ({
  ...a,
  icon: a.icon ? asset(a.icon) : a.icon,
}));

interface DesktopStore {
  /** All apps: builtins + remote (full catalog, used by the app menu) */
  apps: DesktopEntry[];
  /** Desktop surface icons: builtins + ~/Desktop shortcuts */
  desktopIcons: DesktopEntry[];
  wallpaper: string;

  setApps: (apps: DesktopEntry[]) => void;
  setWallpaper: (url: string) => void;
  fetchRemoteApps: (apiDomain: string) => Promise<void>;
}

export const useDesktopStore = create<DesktopStore>((set) => ({
  apps: BUILTIN_APPS_BASED,
  desktopIcons: BUILTIN_APPS_BASED,
  wallpaper: asset("/wallpapers/default.svg"),

  setApps: (apps) => set({ apps }),

  setWallpaper: (url) => set({ wallpaper: url }),

  // No-op. This used to fetch /desktop-entries from the remote services daemon
  // to merge installed Linux apps into the launcher. That backend is gone;
  // app-launching moves to in-guest exec via the in-page sandbox (handled in a
  // separate task). Only the BUILTIN_APPS set is exposed for now. Signature is
  // unchanged so existing callers keep compiling.
  fetchRemoteApps: async (_apiDomain) => {
    void _apiDomain;
  },
}));
