import { contextBridge, ipcRenderer } from "electron";
import type { ConnectionProfile } from "./connections";
import type {
  AtelierDocNameEntry,
  AtelierDocument,
  AtelierQueryResult,
  AtelierSearchFileResult,
  AtelierServerInfo,
  DocumentReadOnlyStatus,
  RestCallResult,
  StudioMenu,
  StudioUserAction,
} from "./atelier";

export interface AgentEvent {
  runId: string;
  line: string;
  stderr?: boolean;
}

export interface AgentDone {
  runId: string;
  code: number;
}

export interface AgentPendingWrite {
  pendingId: string;
  runId: string;
  name: string;
  patch: string;
}

contextBridge.exposeInMainWorld("electronAPI", {
  getVersions: () => ({
    chrome: process.versions.chrome,
    node: process.versions.node,
    electron: process.versions.electron,
  }),
  onMainMessage: (callback: (message: string) => void) => {
    ipcRenderer.on("main-message", (_event, message) => callback(message));
  },
  windowControls: {
    minimize: (): Promise<void> => ipcRenderer.invoke("window:minimize"),
    toggleMaximize: (): Promise<void> => ipcRenderer.invoke("window:toggleMaximize"),
    close: (): Promise<void> => ipcRenderer.invoke("window:close"),
    onCloseRequested: (callback: () => void): void => {
      ipcRenderer.on("window:close-requested", () => callback());
    },
    confirmClose: (): Promise<void> => ipcRenderer.invoke("window:confirmClose"),
  },
  connections: {
    list: (): Promise<ConnectionProfile[]> => ipcRenderer.invoke("connections:list"),
    save: (
      profile: Omit<ConnectionProfile, "id"> & { id?: string },
      password?: string,
    ): Promise<ConnectionProfile> => ipcRenderer.invoke("connections:save", profile, password),
    delete: (id: string): Promise<void> => ipcRenderer.invoke("connections:delete", id),
  },
  atelier: {
    test: (id: string): Promise<AtelierServerInfo> => ipcRenderer.invoke("atelier:test", id),
    listNamespaces: (id: string): Promise<string[]> =>
      ipcRenderer.invoke("atelier:listNamespaces", id),
    listDocuments: (
      id: string,
      namespace: string,
      includeSystem?: boolean,
    ): Promise<AtelierDocNameEntry[]> =>
      ipcRenderer.invoke("atelier:listDocuments", id, namespace, includeSystem),
    getDocument: (id: string, namespace: string, name: string): Promise<AtelierDocument> =>
      ipcRenderer.invoke("atelier:getDocument", id, namespace, name),
    getDocumentReadOnlyStatus: (
      id: string,
      namespace: string,
      name: string,
    ): Promise<DocumentReadOnlyStatus> =>
      ipcRenderer.invoke("atelier:getDocumentReadOnlyStatus", id, namespace, name),
    searchInFiles: (
      id: string,
      namespace: string,
      query: string,
      documents: string,
      includeSystem?: boolean,
    ): Promise<AtelierSearchFileResult[]> =>
      ipcRenderer.invoke("atelier:searchInFiles", id, namespace, query, documents, includeSystem),
    saveDocument: (
      id: string,
      namespace: string,
      name: string,
      contentLines: string[],
    ): Promise<void> =>
      ipcRenderer.invoke("atelier:saveDocument", id, namespace, name, contentLines),
    deleteDocument: (id: string, namespace: string, name: string): Promise<void> =>
      ipcRenderer.invoke("atelier:deleteDocument", id, namespace, name),
    compile: (id: string, namespace: string, docs: string[]): Promise<string[]> =>
      ipcRenderer.invoke("atelier:compile", id, namespace, docs),
    query: (
      id: string,
      namespace: string,
      sql: string,
      parameters: unknown[],
    ): Promise<AtelierQueryResult> =>
      ipcRenderer.invoke("atelier:query", id, namespace, sql, parameters),
    callRoute: (
      id: string,
      path: string,
      method: string,
      headers: Record<string, string>,
      body?: string,
    ): Promise<RestCallResult> =>
      ipcRenderer.invoke("atelier:callRoute", id, path, method, headers, body),
    isStudioExtensionEnabled: (id: string, namespace: string): Promise<boolean> =>
      ipcRenderer.invoke("atelier:isStudioExtensionEnabled", id, namespace),
    getStudioMenus: (
      id: string,
      namespace: string,
      menuType: "main" | "context",
      docName: string,
      selectedText?: string,
    ): Promise<StudioMenu[]> =>
      ipcRenderer.invoke("atelier:getStudioMenus", id, namespace, menuType, docName, selectedText),
    invokeStudioUserAction: (
      id: string,
      namespace: string,
      type: number,
      actionId: string,
      docName: string,
      selectedText?: string,
    ): Promise<StudioUserAction | null> =>
      ipcRenderer.invoke(
        "atelier:invokeStudioUserAction",
        id,
        namespace,
        type,
        actionId,
        docName,
        selectedText,
      ),
    invokeStudioAfterUserAction: (
      id: string,
      namespace: string,
      type: number,
      actionId: string,
      docName: string,
      answer: string,
      msg: string,
    ): Promise<StudioUserAction | null> =>
      ipcRenderer.invoke(
        "atelier:invokeStudioAfterUserAction",
        id,
        namespace,
        type,
        actionId,
        docName,
        answer,
        msg,
      ),
  },
  studio: {
    openCspAction: (url: string): Promise<"1" | "2"> =>
      ipcRenderer.invoke("studio:openCspAction", url),
  },
  files: {
    saveText: (suggestedName: string, content: string): Promise<string | null> =>
      ipcRenderer.invoke("dialog:saveTextFile", suggestedName, content),
  },
  terminal: {
    openExternal: (cwd?: string): Promise<void> => ipcRenderer.invoke("terminal:openExternal", cwd),
  },
  agent: {
    run: (
      connectionId: string,
      namespace: string,
      prompt: string,
      model?: string,
    ): Promise<string> => ipcRenderer.invoke("agent:run", connectionId, namespace, prompt, model),
    abort: (runId: string): Promise<void> => ipcRenderer.invoke("agent:abort", runId),
    resolvePendingWrite: (pendingId: string, approved: boolean): Promise<void> =>
      ipcRenderer.invoke("agent:resolvePendingWrite", pendingId, approved),
    onEvent: (callback: (payload: AgentEvent) => void): (() => void) => {
      const handler = (_event: unknown, payload: AgentEvent) => callback(payload);
      ipcRenderer.on("agent:event", handler);
      return () => ipcRenderer.removeListener("agent:event", handler);
    },
    onDone: (callback: (payload: AgentDone) => void): (() => void) => {
      const handler = (_event: unknown, payload: AgentDone) => callback(payload);
      ipcRenderer.on("agent:done", handler);
      return () => ipcRenderer.removeListener("agent:done", handler);
    },
    onPendingWrite: (callback: (payload: AgentPendingWrite) => void): (() => void) => {
      const handler = (_event: unknown, payload: AgentPendingWrite) => callback(payload);
      ipcRenderer.on("agent:pendingWrite", handler);
      return () => ipcRenderer.removeListener("agent:pendingWrite", handler);
    },
  },
});
