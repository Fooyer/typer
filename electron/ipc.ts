import { BrowserWindow, dialog, ipcMain } from "electron";
import { promises as fs } from "node:fs";
import * as connections from "./connections";
import * as atelier from "./atelier";
import { openStudioCspWindow } from "./studioCspWindow";
import type { ConnectionProfile } from "./connections";
import type { AtelierConnectionConfig } from "./atelier";

function toAtelierConfig(profile: ConnectionProfile): AtelierConnectionConfig {
  const password = connections.getPassword(profile.id);
  if (password === undefined) {
    throw new Error(
      `Sem senha salva para "${profile.name}". Edite a conexão e informe a senha novamente.`,
    );
  }
  return {
    host: profile.host,
    port: profile.port,
    https: profile.https,
    pathPrefix: profile.pathPrefix,
    username: profile.username,
    password,
  };
}

function getProfileOrThrow(id: string): ConnectionProfile {
  const profile = connections.listConnections().find((connection) => connection.id === id);
  if (!profile) throw new Error("Conexão não encontrada.");
  return profile;
}

export function registerIpcHandlers(): void {
  ipcMain.handle("window:minimize", (event) =>
    BrowserWindow.fromWebContents(event.sender)?.minimize(),
  );

  ipcMain.handle("window:toggleMaximize", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  ipcMain.handle("window:close", (event) => BrowserWindow.fromWebContents(event.sender)?.close());

  ipcMain.handle("connections:list", () => connections.listConnections());

  ipcMain.handle(
    "connections:save",
    (_event, profile: Omit<ConnectionProfile, "id"> & { id?: string }, password?: string) =>
      connections.saveConnection(profile, password),
  );

  ipcMain.handle("connections:delete", (_event, id: string) => {
    const profile = connections.listConnections().find((connection) => connection.id === id);
    if (profile && connections.getPassword(id) !== undefined) {
      atelier.clearSession(toAtelierConfig(profile));
    }
    connections.deleteConnection(id);
  });

  ipcMain.handle("atelier:test", async (_event, id: string) => {
    const profile = getProfileOrThrow(id);
    return atelier.getServerInfo(toAtelierConfig(profile));
  });

  ipcMain.handle("atelier:listNamespaces", async (_event, id: string) => {
    const profile = getProfileOrThrow(id);
    const info = await atelier.getServerInfo(toAtelierConfig(profile));
    return info.namespaces;
  });

  ipcMain.handle(
    "atelier:listDocuments",
    async (_event, id: string, namespace: string, includeSystem?: boolean) => {
      const profile = getProfileOrThrow(id);
      return atelier.listDocuments(toAtelierConfig(profile), namespace, includeSystem);
    },
  );

  ipcMain.handle(
    "atelier:getDocument",
    async (_event, id: string, namespace: string, name: string) => {
      const profile = getProfileOrThrow(id);
      return atelier.getDocument(toAtelierConfig(profile), namespace, name);
    },
  );

  ipcMain.handle(
    "atelier:searchInFiles",
    async (
      _event,
      id: string,
      namespace: string,
      query: string,
      documents: string,
      includeSystem?: boolean,
    ) => {
      const profile = getProfileOrThrow(id);
      return atelier.searchInFiles(
        toAtelierConfig(profile),
        namespace,
        query,
        documents,
        includeSystem,
      );
    },
  );

  ipcMain.handle(
    "atelier:saveDocument",
    async (_event, id: string, namespace: string, name: string, contentLines: string[]) => {
      const profile = getProfileOrThrow(id);
      await atelier.saveDocument(toAtelierConfig(profile), namespace, name, contentLines);
    },
  );

  ipcMain.handle(
    "atelier:deleteDocument",
    async (_event, id: string, namespace: string, name: string) => {
      const profile = getProfileOrThrow(id);
      await atelier.deleteDocument(toAtelierConfig(profile), namespace, name);
    },
  );

  ipcMain.handle(
    "atelier:compile",
    async (_event, id: string, namespace: string, docs: string[]) => {
      const profile = getProfileOrThrow(id);
      return atelier.compileDocuments(toAtelierConfig(profile), namespace, docs);
    },
  );

  ipcMain.handle(
    "atelier:query",
    async (_event, id: string, namespace: string, sql: string, parameters: unknown[]) => {
      const profile = getProfileOrThrow(id);
      return atelier.runQuery(toAtelierConfig(profile), namespace, sql, parameters);
    },
  );

  ipcMain.handle(
    "atelier:callRoute",
    async (
      _event,
      id: string,
      path: string,
      method: string,
      headers: Record<string, string>,
      body?: string,
    ) => {
      const profile = getProfileOrThrow(id);
      return atelier.callRestRoute(toAtelierConfig(profile), path, method, headers, body);
    },
  );

  ipcMain.handle(
    "atelier:isStudioExtensionEnabled",
    async (_event, id: string, namespace: string) => {
      const profile = getProfileOrThrow(id);
      return atelier.isStudioExtensionEnabled(toAtelierConfig(profile), namespace);
    },
  );

  ipcMain.handle(
    "atelier:getStudioMenus",
    async (
      _event,
      id: string,
      namespace: string,
      menuType: "main" | "context",
      docName: string,
      selectedText?: string,
    ) => {
      const profile = getProfileOrThrow(id);
      return atelier.getStudioMenus(
        toAtelierConfig(profile),
        namespace,
        menuType,
        docName,
        selectedText,
      );
    },
  );

  ipcMain.handle(
    "atelier:invokeStudioUserAction",
    async (
      _event,
      id: string,
      namespace: string,
      type: number,
      actionId: string,
      docName: string,
      selectedText?: string,
    ) => {
      const profile = getProfileOrThrow(id);
      return atelier.invokeStudioUserAction(
        toAtelierConfig(profile),
        namespace,
        type,
        actionId,
        docName,
        selectedText,
      );
    },
  );

  ipcMain.handle(
    "atelier:invokeStudioAfterUserAction",
    async (
      _event,
      id: string,
      namespace: string,
      type: number,
      actionId: string,
      docName: string,
      answer: string,
      msg: string,
    ) => {
      const profile = getProfileOrThrow(id);
      return atelier.invokeStudioAfterUserAction(
        toAtelierConfig(profile),
        namespace,
        type,
        actionId,
        docName,
        answer,
        msg,
      );
    },
  );

  ipcMain.handle("studio:openCspAction", async (_event, url: string) => openStudioCspWindow(url));

  ipcMain.handle("dialog:saveTextFile", async (event, suggestedName: string, content: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const options = {
      defaultPath: suggestedName,
      filters: [
        { name: "XML", extensions: ["xml"] },
        { name: "Todos os arquivos", extensions: ["*"] },
      ],
    };
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    await fs.writeFile(result.filePath, content, "utf-8");
    return result.filePath;
  });
}
