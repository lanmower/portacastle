import { create } from "zustand";
import type { DesktopEntry } from "@/types/desktop-entry";

/**
 * Map of app name patterns (lowercase) to Dusk icon SVG filenames.
 * Used to override Linux icon theme icons with consistent Dusk icons
 * for well-known applications installed via X11/sandbox.
 * Icons from https://github.com/pacocoursey/Dusk
 */
const DUSK_ICON_MAP: Record<string, string> = {
  // Browsers
  firefox: "firefox",
  "google chrome": "chrome",
  chrome: "chrome",
  chromium: "chrome",
  brave: "brave",
  "brave browser": "brave",
  safari: "safari",
  vivaldi: "vivaldi",
  // Communication
  discord: "discord",
  slack: "slack",
  telegram: "telegram",
  "telegram desktop": "telegram",
  whatsapp: "whatsapp",
  skype: "skype",
  zoom: "zoom",
  "microsoft teams": "teams",
  teams: "teams",
  "facebook messenger": "messenger",
  messenger: "messenger",
  // Media
  spotify: "spotify",
  vlc: "vlc",
  "vlc media player": "vlc",
  obs: "obs",
  "obs studio": "obs",
  itunes: "itunes",
  // Dev tools
  "visual studio code": "vscode",
  "code - oss": "vscode",
  intellij: "intellij",
  "intellij idea": "intellij",
  atom: "atom",
  iterm2: "iterm2",
  iterm: "iterm2",
  hyper: "hyper",
  "github desktop": "github_desktop",
  postman: "postman",
  "mongodb compass": "mongodb",
  "sequel pro": "sequel_pro",
  tableplus: "tableplus",
  // Graphics / Design
  gimp: "gimp",
  "gnu image manipulation program": "gimp",
  figma: "figma",
  sketch: "sketch",
  framer: "framer",
  // Productivity
  notion: "notion",
  todoist: "todoist",
  trello: "trello",
  notes: "notes",
  reminders: "reminders",
  calendar: "calendar",
  mail: "mail",
  // Gaming
  steam: "steam",
  // System / Utilities
  "system monitor": "activity_monitor",
  "text editor": "pages",
  "image viewer": "preview",
  "document viewer": "notes",
  // X11 utilities
  xeyes: "xeyes",
  // Other
  calculator: "calculator",
  photos: "photos",
  dropbox: "dropbox",
  electron: "electron",
};

function getDuskIcon(appName: string): string | null {
  const key = appName.toLowerCase();
  const match = DUSK_ICON_MAP[key];
  if (match) return `/icons/dusk/${match}.svg`;
  return null;
}

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
];

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
  apps: BUILTIN_APPS,
  desktopIcons: BUILTIN_APPS,
  wallpaper: "/wallpapers/default.svg",

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
