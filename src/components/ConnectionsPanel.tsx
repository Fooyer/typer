import { useEffect, useMemo, useState } from "react";
import type { ConnectionProfile } from "../../electron/connections";
import type { AtelierDocNameEntry } from "../../electron/atelier";
import {
  buildDocumentTree,
  type TreeFile,
  type TreeFolder,
  type TreeNode,
} from "../utils/documentTree";
import { isNoiseDocument } from "../utils/documentFilters";
import { matchesGlob } from "../utils/glob";
import { classSourceToExportXml } from "../utils/classXmlExport";
import { setKnownClasses } from "../monaco/classIndex";
import FileExplorer from "./FileExplorer";
import SidebarSection from "./SidebarSection";
import type { LogLevel } from "./OutputPanel";

interface ConnectionsPanelProps {
  onOpenDocument: (connectionId: string, namespace: string, name: string, content: string) => void;
  onLog: (message: string, level?: LogLevel) => void;
  onDocumentDeleted?: (connectionId: string, namespace: string, docName: string) => void;
  onDocumentRenamed?: (
    connectionId: string,
    namespace: string,
    oldName: string,
    newName: string,
  ) => void;
  onOpenApiTester?: (connectionId: string, namespace: string, docName: string) => void;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const EMPTY_FORM = {
  id: undefined as string | undefined,
  name: "",
  host: "localhost",
  port: 52773,
  https: false,
  pathPrefix: "",
  username: "_SYSTEM",
  namespace: "USER",
  password: "",
};

const CLASS_TEMPLATE = (fullName: string) => [
  `Class ${fullName} Extends %RegisteredObject`,
  "{",
  "",
  "}",
  "",
];

function ConnectionsPanel({
  onOpenDocument,
  onLog,
  onDocumentDeleted,
  onDocumentRenamed,
  onOpenApiTester,
}: ConnectionsPanelProps) {
  const [connections, setConnections] = useState<ConnectionProfile[]>([]);
  const [explorerCollapsed, setExplorerCollapsed] = useState(false);
  const [connectionsCollapsed, setConnectionsCollapsed] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [activeNamespace, setActiveNamespace] = useState<string>("");
  const [allDocuments, setAllDocuments] = useState<AtelierDocNameEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [showSystemFiles, setShowSystemFiles] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    node: TreeNode | null;
  } | null>(null);
  const [newClassDialogOpen, setNewClassDialogOpen] = useState(false);
  const [newClassName, setNewClassName] = useState("");
  const [renameTarget, setRenameTarget] = useState<{
    docName: string;
    prefix: string;
    ext: string;
    value: string;
  } | null>(null);
  const [connectingTo, setConnectingTo] = useState<string | null>(null);

  const hasElectronAPI = typeof window.electronAPI !== "undefined";

  const filteredDocuments = useMemo(
    () =>
      allDocuments.filter(
        (doc) => (showSystemFiles || !isNoiseDocument(doc.name)) && matchesGlob(filter, doc.name),
      ),
    [allDocuments, filter, showSystemFiles],
  );

  // Rebuilding the tree is O(documents) and every render that skips this memo (e.g. opening a
  // context menu, typing in the new-connection form) would otherwise redo it and hand FileExplorer a
  // brand-new `nodes` array — even though nothing about the file list changed — which in turn forces
  // its own memoized row-flattening to redo its work too. Keyed on filteredDocuments so it only
  // recomputes when the visible document set actually changes.
  const documentTree = useMemo(() => buildDocumentTree(filteredDocuments), [filteredDocuments]);

  useEffect(() => {
    if (!hasElectronAPI) return;
    window.electronAPI.connections.list().then(setConnections);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [contextMenu]);

  async function refreshConnections() {
    setConnections(await window.electronAPI.connections.list());
  }

  async function saveConnection() {
    const { password, ...profile } = form;
    await window.electronAPI.connections.save(profile, password || undefined);
    setForm(EMPTY_FORM);
    setFormOpen(false);
    await refreshConnections();
    onLog(`Conexão "${profile.name || profile.host}" salva.`, "success");
  }

  async function deleteConnection(id: string) {
    await window.electronAPI.connections.delete(id);
    if (activeId === id) {
      setActiveId(null);
      setAllDocuments([]);
      setNamespaces([]);
    }
    await refreshConnections();
  }

  function editConnection(connection: ConnectionProfile) {
    setForm({ ...connection, pathPrefix: connection.pathPrefix ?? "", password: "" });
    setFormOpen(true);
  }

  function newConnection() {
    setForm(EMPTY_FORM);
    setFormOpen(true);
  }

  async function testConnection(id: string) {
    onLog("Testando conexão…");
    try {
      const info = await window.electronAPI.atelier.test(id);
      onLog(`Conexão OK — servidor ${info.version} (API v${info.api})`, "success");
    } catch (error) {
      onLog(`Erro ao testar conexão: ${(error as Error).message}`, "error");
    }
  }

  async function loadDocuments(id: string, namespace: string) {
    onLog(`Listando arquivos em ${namespace}…`);
    try {
      const docs = await window.electronAPI.atelier.listDocuments(id, namespace);
      setAllDocuments(docs);
      setKnownClasses(
        docs
          .filter((doc) => doc.name.toLowerCase().endsWith(".cls"))
          .map((doc) => doc.name.replace(/\.cls$/i, "")),
      );
      onLog(
        docs.length
          ? `${docs.length} arquivo(s) encontrado(s) em ${namespace}.`
          : `Nenhum arquivo encontrado em ${namespace}.`,
      );
    } catch (error) {
      onLog(`Erro ao listar arquivos: ${(error as Error).message}`, "error");
      setAllDocuments([]);
    }
  }

  async function connect(connection: ConnectionProfile) {
    const label = connection.name || `${connection.host}:${connection.port}`;
    setActiveId(connection.id);
    setAllDocuments([]);
    setExplorerCollapsed(false);
    setConnectionsCollapsed(true);
    setConnectingTo(label);
    onLog(`Conectando a "${label}"…`);
    try {
      const availableNamespaces = await window.electronAPI.atelier.listNamespaces(connection.id);
      setNamespaces(availableNamespaces);
      const namespace = availableNamespaces.includes(connection.namespace)
        ? connection.namespace
        : availableNamespaces[0];
      setActiveNamespace(namespace);
      onLog(`Conectado. Namespaces disponíveis: ${availableNamespaces.join(", ")}.`, "success");
      await loadDocuments(connection.id, namespace);
    } catch (error) {
      onLog(`Erro ao conectar: ${(error as Error).message}`, "error");
    } finally {
      setConnectingTo(null);
    }
  }

  function changeNamespace(namespace: string) {
    setActiveNamespace(namespace);
    if (activeId) void loadDocuments(activeId, namespace);
  }

  async function openDocument(name: string) {
    if (!activeId || !activeNamespace) return;
    onLog(`Abrindo ${name}…`);
    try {
      const doc = await window.electronAPI.atelier.getDocument(activeId, activeNamespace, name);
      onOpenDocument(activeId, activeNamespace, name, doc.content.join("\n"));
    } catch (error) {
      onLog(`Erro ao abrir ${name}: ${(error as Error).message}`, "error");
    }
  }

  function openNewClassDialog(prefix = "") {
    setNewClassName(prefix);
    setNewClassDialogOpen(true);
  }

  async function submitNewClass() {
    if (!activeId || !activeNamespace || !newClassName.trim()) return;
    const fullName = newClassName.trim().replace(/\.cls$/i, "");
    const docName = `${fullName}.cls`;
    setNewClassDialogOpen(false);
    setNewClassName("");
    onLog(`Criando ${docName}…`);
    try {
      const template = CLASS_TEMPLATE(fullName);
      await window.electronAPI.atelier.saveDocument(activeId, activeNamespace, docName, template);
      onLog(`${docName} criado.`, "success");
      await loadDocuments(activeId, activeNamespace);
      onOpenDocument(activeId, activeNamespace, docName, template.join("\n"));
    } catch (error) {
      onLog(`Erro ao criar ${docName}: ${(error as Error).message}`, "error");
    }
  }

  function handleContextMenu(event: React.MouseEvent) {
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY, node: null });
  }

  function handleNodeContextMenu(node: TreeNode, x: number, y: number) {
    setContextMenu({ x, y, node });
  }

  function openRenameDialog(node: TreeFile) {
    setContextMenu(null);
    const prefix = node.docName.slice(0, node.docName.length - node.name.length);
    const ext = node.name.includes(".") ? node.name.slice(node.name.lastIndexOf(".") + 1) : "";
    setRenameTarget({ docName: node.docName, prefix, ext, value: node.name });
  }

  async function submitRename() {
    if (!activeId || !activeNamespace || !renameTarget) return;
    const { docName: oldDocName, prefix, ext, value } = renameTarget;
    let newLeaf = value.trim();
    if (ext && !newLeaf.toLowerCase().endsWith(`.${ext.toLowerCase()}`))
      newLeaf = `${newLeaf}.${ext}`;
    const newDocName = `${prefix}${newLeaf}`;
    setRenameTarget(null);
    if (newDocName === oldDocName || !newLeaf) return;
    if (newDocName.toLowerCase() === oldDocName.toLowerCase()) {
      // IRIS resolves class/routine names case-insensitively, so "renaming" to a name that only
      // differs in letter case doesn't create a separate document — the save silently lands back
      // on the same existing one (confirmed: this previously corrupted the class's own declaration
      // line without ever creating the "new" name, then failed to compile it). Refuse instead of
      // risking that half-done state.
      onLog(
        `Não é possível renomear "${oldDocName}" para "${newDocName}": o IRIS não diferencia maiúsculas de minúsculas em nomes de classes/rotinas, então isso não conta como um nome novo. Escolha um nome que difira em mais que a capitalização.`,
        "error",
      );
      return;
    }
    onLog(`Renomeando ${oldDocName} para ${newDocName}…`);
    try {
      const doc = await window.electronAPI.atelier.getDocument(
        activeId,
        activeNamespace,
        oldDocName,
      );
      let lines = doc.content;
      if (ext.toLowerCase() === "cls") {
        const oldFullName = oldDocName.replace(/\.cls$/i, "");
        const newFullName = newDocName.replace(/\.cls$/i, "");
        const declIndex = lines.findIndex((line) => /^\s*Class\s+/i.test(line));
        if (declIndex >= 0) {
          lines = [...lines];
          lines[declIndex] = lines[declIndex].replace(
            new RegExp(escapeRegExp(oldFullName)),
            newFullName,
          );
        }
      }
      await window.electronAPI.atelier.saveDocument(activeId, activeNamespace, newDocName, lines);
      const output = await window.electronAPI.atelier.compile(activeId, activeNamespace, [
        newDocName,
      ]);
      output.forEach((line) => onLog(line, "info"));
      await window.electronAPI.atelier.deleteDocument(activeId, activeNamespace, oldDocName);
      await loadDocuments(activeId, activeNamespace);
      onDocumentRenamed?.(activeId, activeNamespace, oldDocName, newDocName);
      onLog(`${oldDocName} renomeado para ${newDocName}.`, "success");
    } catch (error) {
      onLog(`Erro ao renomear ${oldDocName}: ${(error as Error).message}`, "error");
    }
  }

  async function requestDelete(node: TreeFile) {
    setContextMenu(null);
    if (!activeId || !activeNamespace) return;
    if (!window.confirm(`Excluir "${node.docName}"? Esta ação não pode ser desfeita.`)) return;
    onLog(`Excluindo ${node.docName}…`);
    try {
      await window.electronAPI.atelier.deleteDocument(activeId, activeNamespace, node.docName);
      await loadDocuments(activeId, activeNamespace);
      onDocumentDeleted?.(activeId, activeNamespace, node.docName);
      onLog(`${node.docName} excluído.`, "success");
    } catch (error) {
      onLog(`Erro ao excluir ${node.docName}: ${(error as Error).message}`, "error");
    }
  }

  async function exportClassXml(node: TreeFile) {
    setContextMenu(null);
    if (!activeId || !activeNamespace) return;
    onLog(`Exportando ${node.docName} como XML…`);
    try {
      const doc = await window.electronAPI.atelier.getDocument(
        activeId,
        activeNamespace,
        node.docName,
      );
      const { xml, className } = classSourceToExportXml(doc.content);
      const savedPath = await window.electronAPI.files.saveText(`${className}.cls.xml`, xml);
      if (savedPath) onLog(`${node.docName} exportado para ${savedPath}.`, "success");
    } catch (error) {
      onLog(`Erro ao exportar ${node.docName}: ${(error as Error).message}`, "error");
    }
  }

  if (!hasElectronAPI) {
    return (
      <div className="sidebar">
        <p className="connection-status">
          Disponível apenas rodando no app Electron — este recurso usa IPC com o processo principal.
        </p>
      </div>
    );
  }

  return (
    <div className="sidebar">
      <SidebarSection
        title="Explorador"
        collapsed={explorerCollapsed}
        onToggleCollapsed={() => setExplorerCollapsed((value) => !value)}
        actions={
          activeId ? (
            <button type="button" onClick={() => openNewClassDialog()} title="Nova classe">
              🧩+
            </button>
          ) : undefined
        }
      >
        {!activeId ? (
          <p className="connection-status">
            Conecte-se a um servidor abaixo para navegar pelos arquivos.
          </p>
        ) : (
          <div className="documents-list" onContextMenu={handleContextMenu}>
            <label className="namespace-select">
              Namespace
              <select
                value={activeNamespace}
                onChange={(event) => changeNamespace(event.target.value)}
              >
                {namespaces.map((namespace) => (
                  <option key={namespace} value={namespace}>
                    {namespace}
                  </option>
                ))}
              </select>
            </label>
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filtro por nome (ex: *.cls)"
            />
            <label className="show-system-toggle">
              <input
                type="checkbox"
                checked={showSystemFiles}
                onChange={(event) => setShowSystemFiles(event.target.checked)}
              />
              Mostrar arquivos do sistema (Ens*, CSPX, .mac, .inc)
            </label>
            <FileExplorer
              nodes={documentTree}
              onOpenFile={openDocument}
              onNodeContextMenu={handleNodeContextMenu}
            />
          </div>
        )}
      </SidebarSection>

      <SidebarSection
        title="Conexões"
        collapsed={connectionsCollapsed}
        onToggleCollapsed={() => setConnectionsCollapsed((value) => !value)}
        grow={false}
        actions={
          <button type="button" onClick={newConnection} title="Nova conexão">
            +
          </button>
        }
      >
        <ul className="connections-list">
          {connections.map((connection) => (
            <li key={connection.id} className={connection.id === activeId ? "active" : ""}>
              <span
                className="connection-name"
                onClick={() => connect(connection)}
                title="Conectar e ver arquivos"
              >
                🖥️ {connection.name || `${connection.host}:${connection.port}`}
              </span>
              <button
                type="button"
                onClick={() => testConnection(connection.id)}
                title="Testar conexão"
              >
                ●
              </button>
              <button type="button" onClick={() => editConnection(connection)} title="Editar">
                ✎
              </button>
              <button type="button" onClick={() => deleteConnection(connection.id)} title="Remover">
                ✕
              </button>
            </li>
          ))}
          {connections.length === 0 && (
            <li className="connections-empty">Nenhuma conexão ainda.</li>
          )}
        </ul>
      </SidebarSection>

      {formOpen && (
        <div className="modal-overlay" onClick={() => setFormOpen(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h4>{form.id ? "Editar conexão" : "Nova conexão"}</h4>
            <label>
              Nome
              <input
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </label>
            <label>
              Host
              <input
                value={form.host}
                onChange={(event) => setForm({ ...form, host: event.target.value })}
              />
            </label>
            <label>
              Porta
              <input
                type="number"
                value={form.port}
                onChange={(event) => setForm({ ...form, port: Number(event.target.value) })}
              />
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={form.https}
                onChange={(event) => setForm({ ...form, https: event.target.checked })}
              />
              HTTPS
            </label>
            <label>
              Namespace padrão
              <input
                value={form.namespace}
                onChange={(event) => setForm({ ...form, namespace: event.target.value })}
              />
            </label>
            <label>
              Usuário
              <input
                value={form.username}
                onChange={(event) => setForm({ ...form, username: event.target.value })}
              />
            </label>
            <label>
              Senha
              <input
                type="password"
                value={form.password}
                placeholder={form.id ? "(mantém a senha salva se em branco)" : ""}
                onChange={(event) => setForm({ ...form, password: event.target.value })}
              />
            </label>
            <div className="modal-actions">
              <button type="button" onClick={saveConnection}>
                Salvar
              </button>
              <button type="button" onClick={() => setFormOpen(false)}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {contextMenu && (
        <ul className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          {contextMenu.node === null && (
            <li onClick={() => openNewClassDialog()}>🧩 Nova Classe…</li>
          )}
          {contextMenu.node?.type === "folder" &&
            (() => {
              const folder = contextMenu.node as TreeFolder;
              return (
                <li onClick={() => openNewClassDialog(`${folder.path}.`)}>🧩 Nova Classe aqui…</li>
              );
            })()}
          {contextMenu.node?.type === "file" &&
            (() => {
              const file = contextMenu.node as TreeFile;
              return (
                <>
                  <li onClick={() => openRenameDialog(file)}>✎ Renomear…</li>
                  {file.docName.toLowerCase().endsWith(".cls") && (
                    <li onClick={() => void exportClassXml(file)}>📤 Exportar como XML…</li>
                  )}
                  {file.docName.toLowerCase().endsWith(".cls") && onOpenApiTester && (
                    <li
                      onClick={() => {
                        setContextMenu(null);
                        if (activeId && activeNamespace)
                          onOpenApiTester(activeId, activeNamespace, file.docName);
                      }}
                    >
                      🔌 Testar Rotas da API…
                    </li>
                  )}
                  <li onClick={() => requestDelete(file)}>🗑️ Excluir</li>
                </>
              );
            })()}
        </ul>
      )}

      {newClassDialogOpen && (
        <div className="modal-overlay" onClick={() => setNewClassDialogOpen(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h4>Nova Classe</h4>
            <input
              autoFocus
              value={newClassName}
              onChange={(event) => setNewClassName(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && submitNewClass()}
              placeholder="Pacote.NomeDaClasse"
            />
            <div className="modal-actions">
              <button type="button" onClick={submitNewClass}>
                Criar
              </button>
              <button type="button" onClick={() => setNewClassDialogOpen(false)}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {renameTarget && (
        <div className="modal-overlay" onClick={() => setRenameTarget(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h4>Renomear</h4>
            <input
              autoFocus
              value={renameTarget.value}
              onChange={(event) => setRenameTarget({ ...renameTarget, value: event.target.value })}
              onKeyDown={(event) => event.key === "Enter" && submitRename()}
            />
            <div className="modal-actions">
              <button type="button" onClick={submitRename}>
                Renomear
              </button>
              <button type="button" onClick={() => setRenameTarget(null)}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {connectingTo && (
        <div className="connecting-overlay">
          <div className="connecting-spinner" />
          <div className="connecting-message">Conectando ao servidor {connectingTo}…</div>
        </div>
      )}
    </div>
  );
}

export default ConnectionsPanel;
