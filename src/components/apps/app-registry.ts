"use client";

import { TerminalApp } from "./terminal/TerminalApp";
import { FileManager } from "./file-manager/FileManager";
import { Settings } from "./settings/Settings";
import { CodeServerApp } from "./code-server/CodeServerApp";
import { AppStore } from "./app-store/AppStore";
import { GuiDesktopApp } from "./gui-desktop/GuiDesktopApp";

export const APP_COMPONENTS: Record<string, React.ComponentType<{ meta?: Record<string, unknown> }>> = {
  terminal: TerminalApp,
  "file-manager": FileManager,
  settings: Settings,
  "code-server": CodeServerApp,
  "app-store": AppStore,
  // In-guest framebuffer GUI app rendered on a canvas (xappdemo.elf), via the
  // host-driven render-once loop.
  "gui-desktop": GuiDesktopApp,
};
