import { ipcRenderer } from "electron";

// Server-authored CSP pages that participate in a Studio custom-menu action (e.g. a login flow)
// signal completion the same way they do for Studio/vscode-objectscript's own webview: by posting
// `{ result: "done" }` to the window. Relay that back to the main process, which is waiting on it.
const channelArg = process.argv.find((arg) => arg.startsWith("--studio-csp-channel="));
const channel = channelArg?.split("=")[1];

if (channel) {
  window.addEventListener("message", (event) => {
    const data = event.data as { result?: string } | undefined;
    if (data?.result === "done") ipcRenderer.send(channel, data);
  });
}
