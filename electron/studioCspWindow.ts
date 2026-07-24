import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, ipcMain } from "electron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Opens a Studio custom-menu "run a CSP page" action (e.g. a login flow), loaded directly as the
// window's top-level page (same-origin as the server, so its session cookie actually sticks — an
// <iframe>-wrapper approach was tried and broke the login itself, almost certainly third-party-cookie
// blocking inside a cross-origin iframe). On a real server, once the flow (e.g. login) completes, the
// page's own "OK" button navigates the window again — to a bare Atelier "template" stub response (a
// `##www.intersystems.com:template_delimiter##` marker, not meant to be shown to the user) — and THAT
// second navigation is itself the real completion signal, not something to guard against. Detect it via
// `did-navigate` (the first one is just the initial page load) and finish automatically instead of
// leaving the user staring at raw XML.
export function openStudioCspWindow(url: string): Promise<"1" | "2"> {
  return new Promise((resolve) => {
    const channel = `studio-csp-done-${randomUUID()}`;
    let settled = false;
    let initialLoadSeen = false;

    const win = new BrowserWindow({
      width: 900,
      height: 700,
      title: "Ação do servidor",
      webPreferences: {
        preload: path.join(__dirname, "studioCspPreload.mjs"),
        additionalArguments: [`--studio-csp-channel=${channel}`],
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    const finish = (answer: "1" | "2") => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener(channel, onDone);
      resolve(answer);
      if (!win.isDestroyed()) win.close();
    };

    const onDone = () => finish("1");

    ipcMain.on(channel, onDone);
    win.on("closed", () => finish("1"));
    win.webContents.on("did-navigate", () => {
      if (!initialLoadSeen) {
        initialLoadSeen = true;
        return;
      }
      finish("1");
    });

    win.loadURL(url);
  });
}
