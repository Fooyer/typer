import { spawn } from "node:child_process";
import os from "node:os";

/**
 * Opens a real OS terminal window running `command` in `cwd`. Embedding an actual terminal in the
 * app (xterm.js + node-pty) needs a compiled native module, which needs Visual Studio Build Tools
 * on Windows — not something this app can assume is installed, so this shells out to a normal
 * terminal window instead.
 */
export function openExternalTerminal(cwd: string, command = "opencode"): void {
  if (process.platform === "win32") {
    // Prefer Windows Terminal (respects the user's own profile/theme) and fall back to a plain
    // PowerShell console window if `wt` isn't installed.
    const wt = spawn("wt.exe", ["-d", cwd, "powershell.exe", "-NoExit", "-Command", command], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    wt.on("error", () => {
      spawn("cmd.exe", ["/c", "start", '""', "powershell.exe", "-NoExit", "-Command", command], {
        cwd,
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      }).unref();
    });
    wt.unref();
    return;
  }

  if (process.platform === "linux") {
    // Try a handful of common terminal emulators in turn until one launches successfully.
    const candidates: [string, string[]][] = [
      ["x-terminal-emulator", ["-e", command]],
      ["gnome-terminal", ["--", "bash", "-lc", command]],
      ["konsole", ["-e", command]],
      ["xterm", ["-e", command]],
    ];
    const tryNext = (index: number) => {
      if (index >= candidates.length) return;
      const [bin, args] = candidates[index];
      const child = spawn(bin, args, { cwd, detached: true, stdio: "ignore" });
      child.on("error", () => tryNext(index + 1));
      child.unref();
    };
    tryNext(0);
    return;
  }

  spawn("open", ["-a", "Terminal", cwd], { detached: true, stdio: "ignore" }).unref();
}

export function defaultAgentWorkingDirectory(): string {
  return os.homedir();
}
