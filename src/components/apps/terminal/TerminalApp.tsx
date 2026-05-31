"use client";

import { useEffect, useRef } from "react";
import type { Terminal, FitAddon } from "ghostty-web";
import { useActiveSandbox } from "@/stores/workspace-store";
import { useClientSandboxStore } from "@/stores/client-sandbox-store";
import { NoWorkspacePlaceholder } from "@/components/apps/no-workspace-placeholder";
import { saveTerminalState, loadTerminalState } from "@/lib/terminal/state-cache";

/**
 * In-page terminal.
 *
 * Replaces the remote PTY-over-WebSocket (`wss://services/ws/terminal`) with a
 * line-oriented REPL backed by the in-page portabox sandbox: read a command
 * line, run it via `sandbox.runCommand`, stream stdout/stderr back. No external
 * service is contacted.
 *
 * Note on interactivity: a full streaming PTY (curses apps, live stdin) needs
 * the VM to run continuously while the UI thread feeds input -- that is the
 * worker-scheduling architecture (a long-lived shell in a Web Worker over the
 * threaded build). Until that lands, this is a correct line REPL: one command
 * per Enter, output rendered, prompt redrawn. Filesystem + env persist across
 * commands because the sandbox is a single long-lived host.
 */
const PROMPT = "\x1b[32m$\x1b[0m ";

export function TerminalApp() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { activeWorkspaceId } = useActiveSandbox();
  const ensureSandbox = useClientSandboxStore((s) => s.ensureSandbox);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !activeWorkspaceId) return;

    let disposed = false;
    let connectFrameId: number | null = null;
    let term: Terminal | undefined;
    let fitAddon: FitAddon | undefined;

    connectFrameId = requestAnimationFrame(() => {
      if (disposed) return;
      connectFrameId = null;

      (async () => {
        const ghostty = await import("ghostty-web");
        if (disposed) return;
        await ghostty.init();
        if (disposed) return;

        const t = new ghostty.Terminal({
          fontSize: 14,
          cursorBlink: true,
          fontFamily: 'Monaco, Menlo, "Courier New", monospace',
          theme: { background: "#0a0a0a", foreground: "#ededed", cursor: "#ffffff" },
        });
        term = t;
        const fa = new ghostty.FitAddon();
        fitAddon = fa;
        t.loadAddon(fa);
        t.open(container);
        fa.fit();
        fa.observeResize();
        if (disposed) {
          fa.dispose();
          t.dispose();
          return;
        }

        const cached = loadTerminalState(activeWorkspaceId);
        if (cached) t.write(cached);
        t.write("\r\n\x1b[90m[booting in-page sandbox...]\x1b[0m\r\n");

        let sandbox;
        try {
          sandbox = await ensureSandbox(activeWorkspaceId);
        } catch (err) {
          if (!disposed) {
            t.write(
              `\r\n\x1b[31m[sandbox boot failed: ${
                err instanceof Error ? err.message : String(err)
              }]\x1b[0m\r\n`,
            );
          }
          return;
        }
        if (disposed) return;
        t.write("\x1b[2K\r\x1b[90m[sandbox ready]\x1b[0m\r\n" + PROMPT);

        // Line editor: accumulate keystrokes until Enter, then runCommand.
        let line = "";
        let running = false;

        async function execLine(input: string) {
          const trimmed = input.trim();
          if (!trimmed) {
            t.write(PROMPT);
            return;
          }
          running = true;
          // Split into argv; the sandbox runs the first token as the program,
          // the rest as args (busybox applets resolve by name on PATH).
          const parts = trimmed.split(/\s+/);
          const [cmd, ...args] = parts;
          try {
            const result = await sandbox!.runCommand(cmd, args);
            const out = await result.stdout();
            const errOut = await result.stderr();
            if (out) t.write(out.replace(/\n/g, "\r\n"));
            if (errOut) t.write("\x1b[31m" + errOut.replace(/\n/g, "\r\n") + "\x1b[0m");
            if (result.exitCode !== 0) {
              t.write(`\x1b[90m[exit ${result.exitCode}]\x1b[0m\r\n`);
            }
          } catch (err) {
            t.write(
              `\x1b[31m${err instanceof Error ? err.message : String(err)}\x1b[0m\r\n`,
            );
          } finally {
            running = false;
            if (!disposed) t.write(PROMPT);
          }
        }

        t.onData((data: string) => {
          if (disposed || running) return;
          for (const ch of data) {
            if (ch === "\r" || ch === "\n") {
              t.write("\r\n");
              const toRun = line;
              line = "";
              void execLine(toRun);
            } else if (ch === "\x7f" || ch === "\b") {
              if (line.length > 0) {
                line = line.slice(0, -1);
                t.write("\b \b");
              }
            } else if (ch >= " ") {
              line += ch;
              t.write(ch);
            }
          }
        });
      })();
    });

    return () => {
      disposed = true;
      if (connectFrameId !== null) cancelAnimationFrame(connectFrameId);
      if (term && activeWorkspaceId) {
        try {
          const buffer = term.buffer?.active;
          if (buffer) {
            const lines: string[] = [];
            for (let i = 0; i < buffer.length; i++) {
              const l = buffer.getLine(i);
              if (l) lines.push(l.translateToString(true));
            }
            while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
            if (lines.length > 0) {
              saveTerminalState(activeWorkspaceId, lines.join("\r\n") + "\r\n");
            }
          }
        } catch {
          // best-effort
        }
      }
      fitAddon?.dispose();
      term?.dispose();
    };
  }, [activeWorkspaceId, ensureSandbox]);

  if (!activeWorkspaceId) {
    return (
      <NoWorkspacePlaceholder message="No active workspace. Create one to use the terminal." />
    );
  }

  return (
    <div
      ref={containerRef}
      className="h-full w-full bg-background-100"
      role="application"
      aria-label="Terminal"
    />
  );
}
