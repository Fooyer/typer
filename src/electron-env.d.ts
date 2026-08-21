import type { ConnectionProfile } from "../electron/connections";
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
} from "../electron/atelier";
import type { AgentDone, AgentEvent, AgentPendingWrite, AgentSession } from "../electron/preload";
import type { WriteResolution } from "../electron/agentBridge";
import type { SpecFileEntry } from "../electron/specs";
import type { UpdaterStatus } from "../electron/updater";

export interface ElectronAPI {
  getVersions: () => { chrome: string; node: string; electron: string };
  onMainMessage: (callback: (message: string) => void) => void;
  windowControls: {
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<void>;
    close: () => Promise<void>;
    onCloseRequested: (callback: () => void) => void;
    confirmClose: () => Promise<void>;
  };
  updater: {
    check: () => Promise<void>;
    install: () => Promise<void>;
    onStatus: (callback: (status: UpdaterStatus) => void) => () => void;
  };
  connections: {
    list: () => Promise<ConnectionProfile[]>;
    save: (
      profile: Omit<ConnectionProfile, "id"> & { id?: string },
      password?: string,
    ) => Promise<ConnectionProfile>;
    delete: (id: string) => Promise<void>;
  };
  atelier: {
    test: (id: string) => Promise<AtelierServerInfo>;
    listNamespaces: (id: string) => Promise<string[]>;
    listDocuments: (
      id: string,
      namespace: string,
      includeSystem?: boolean,
    ) => Promise<AtelierDocNameEntry[]>;
    getDocument: (id: string, namespace: string, name: string) => Promise<AtelierDocument>;
    getDocumentReadOnlyStatus: (
      id: string,
      namespace: string,
      name: string,
    ) => Promise<DocumentReadOnlyStatus>;
    searchInFiles: (
      id: string,
      namespace: string,
      query: string,
      documents: string,
      includeSystem?: boolean,
    ) => Promise<AtelierSearchFileResult[]>;
    saveDocument: (
      id: string,
      namespace: string,
      name: string,
      contentLines: string[],
    ) => Promise<void>;
    deleteDocument: (id: string, namespace: string, name: string) => Promise<void>;
    compile: (id: string, namespace: string, docs: string[]) => Promise<string[]>;
    query: (
      id: string,
      namespace: string,
      sql: string,
      parameters: unknown[],
    ) => Promise<AtelierQueryResult>;
    callRoute: (
      id: string,
      path: string,
      method: string,
      headers: Record<string, string>,
      body?: string,
    ) => Promise<RestCallResult>;
    isStudioExtensionEnabled: (id: string, namespace: string) => Promise<boolean>;
    getStudioMenus: (
      id: string,
      namespace: string,
      menuType: "main" | "context",
      docName: string,
      selectedText?: string,
    ) => Promise<StudioMenu[]>;
    invokeStudioUserAction: (
      id: string,
      namespace: string,
      type: number,
      actionId: string,
      docName: string,
      selectedText?: string,
    ) => Promise<StudioUserAction | null>;
    invokeStudioAfterUserAction: (
      id: string,
      namespace: string,
      type: number,
      actionId: string,
      docName: string,
      answer: string,
      msg: string,
    ) => Promise<StudioUserAction | null>;
  };
  studio: {
    openCspAction: (url: string) => Promise<"1" | "2">;
  };
  files: {
    saveText: (suggestedName: string, content: string) => Promise<string | null>;
  };
  agent: {
    run: (
      connectionId: string,
      namespace: string,
      prompt: string,
      specsDir: string,
      model?: string,
      sessionId?: string,
    ) => Promise<string>;
    abort: (runId: string) => Promise<void>;
    resolvePendingWrite: (pendingId: string, approved: boolean) => Promise<WriteResolution | null>;
    onEvent: (callback: (payload: AgentEvent) => void) => () => void;
    onDone: (callback: (payload: AgentDone) => void) => () => void;
    onSession: (callback: (payload: AgentSession) => void) => () => void;
    onPendingWrite: (callback: (payload: AgentPendingWrite) => void) => () => void;
  };
  specs: {
    resolveDir: (
      connectionId: string,
      namespace: string,
      customDir: string | null,
    ) => Promise<string>;
    list: (dir: string) => Promise<SpecFileEntry[]>;
    read: (filePath: string) => Promise<string>;
    write: (filePath: string, content: string) => Promise<void>;
    create: (dir: string, name: string) => Promise<string>;
    delete: (filePath: string) => Promise<void>;
    seedSddTemplate: (dir: string) => Promise<void>;
    rename: (filePath: string, newName: string) => Promise<string>;
    chooseDirectory: (currentDir?: string) => Promise<string | null>;
  };
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
