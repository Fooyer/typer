import { app } from "electron";
import { autoUpdater } from "electron-updater";
import type { BrowserWindow } from "electron";

export type UpdaterStatus =
  | { state: "checking" }
  | { state: "available"; version: string }
  | { state: "not-available" }
  | { state: "downloading"; percent: number }
  | { state: "downloaded"; version: string }
  | { state: "error"; message: string };

let getWindow: () => BrowserWindow | null = () => null;

function send(status: UpdaterStatus): void {
  getWindow()?.webContents.send("updater:status", status);
}

autoUpdater.autoDownload = true;
// We drive the install ourselves from a renderer button (see App.tsx's update pill) rather than
// letting electron-updater install silently on quit, so a restart never surprises the user mid-edit.
autoUpdater.autoInstallOnAppQuit = false;

autoUpdater.on("checking-for-update", () => send({ state: "checking" }));
autoUpdater.on("update-available", (info) => send({ state: "available", version: info.version }));
autoUpdater.on("update-not-available", () => send({ state: "not-available" }));
autoUpdater.on("download-progress", (progress) =>
  send({ state: "downloading", percent: Math.round(progress.percent) }),
);
autoUpdater.on("update-downloaded", (info) => send({ state: "downloaded", version: info.version }));
autoUpdater.on("error", (error) => send({ state: "error", message: error.message }));

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

// checkForUpdates() throws without packaged update metadata (dev.app-update.yml only exists in a
// built+signed release), so both this and the manual re-check below are no-ops outside app.isPackaged.
export function startAutoUpdater(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter;
  if (!app.isPackaged) return;
  void autoUpdater.checkForUpdates();
  setInterval(() => void autoUpdater.checkForUpdates(), CHECK_INTERVAL_MS);
}

export function checkForUpdatesNow(): void {
  if (!app.isPackaged) return;
  void autoUpdater.checkForUpdates();
}

export function installUpdateNow(): void {
  autoUpdater.quitAndInstall();
}
