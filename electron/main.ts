import { app, BrowserWindow, Menu, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isWindowForceClose, registerIpcHandlers } from "./ipc";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.APP_ROOT = path.join(__dirname, "..");

export const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
export const MAIN_DIST = path.join(process.env.APP_ROOT, "dist-electron");
export const RENDERER_DIST = path.join(process.env.APP_ROOT, "dist");

let win: BrowserWindow | null = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    frame: false,
    icon: path.join(process.env.APP_ROOT!, "public", "icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Give the renderer a chance to warn about unsaved tabs before the window actually closes —
  // covers the custom titlebar's close button, Alt+F4, and the OS window-close control alike,
  // since all of them end up firing this same `close` event on the BrowserWindow. Renderer decides
  // (see App.tsx's "window:close-requested" handler) and, if it wants to proceed, calls back
  // through "window:confirmClose", which marks the window and closes it again — this time let
  // through below.
  win.on("close", (event) => {
    if (!win || isWindowForceClose(win)) return;
    event.preventDefault();
    win.webContents.send("window:close-requested");
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http:") || url.startsWith("https:")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(RENDERER_DIST, "index.html"));
  }
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
    win = null;
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  registerIpcHandlers();
  createWindow();
});
