import { useState } from "react";
import type { TreeNode } from "../utils/documentTree";

interface FileExplorerProps {
  nodes: TreeNode[];
  onOpenFile: (docName: string) => void;
  onNodeContextMenu?: (node: TreeNode, x: number, y: number) => void;
}

const FILE_ICONS: Record<string, string> = {
  cls: "🧩",
  mac: "⚙️",
  int: "⚙️",
  inc: "🔖",
  csp: "🌐",
  csr: "🌐",
  bas: "📜",
};

function fileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase();
  return (ext && FILE_ICONS[ext]) || "📄";
}

function FileExplorer({ nodes, onOpenFile, onNodeContextMenu }: FileExplorerProps) {
  return (
    <ul className="file-tree">
      {nodes.map((node) => (
        <TreeNodeItem
          key={node.type === "folder" ? `d:${node.path}` : `f:${node.docName}`}
          node={node}
          onOpenFile={onOpenFile}
          onNodeContextMenu={onNodeContextMenu}
        />
      ))}
    </ul>
  );
}

function TreeNodeItem({
  node,
  onOpenFile,
  onNodeContextMenu,
}: {
  node: TreeNode;
  onOpenFile: (docName: string) => void;
  onNodeContextMenu?: (node: TreeNode, x: number, y: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  function handleContextMenu(event: React.MouseEvent) {
    if (!onNodeContextMenu) return;
    event.preventDefault();
    event.stopPropagation();
    onNodeContextMenu(node, event.clientX, event.clientY);
  }

  if (node.type === "file") {
    return (
      <li
        className="file-tree-file"
        onClick={() => onOpenFile(node.docName)}
        onContextMenu={handleContextMenu}
        title={node.docName}
      >
        <span className="file-tree-icon">{fileIcon(node.name)}</span>
        {node.name}
      </li>
    );
  }

  return (
    <li className="file-tree-folder">
      <span className="file-tree-folder-label" onClick={() => setExpanded((value) => !value)} onContextMenu={handleContextMenu}>
        <span className="file-tree-icon">{expanded ? "📂" : "📁"}</span>
        {node.name}
      </span>
      {expanded && (
        <ul>
          {node.children.map((child) => (
            <TreeNodeItem
              key={child.type === "folder" ? `d:${child.path}` : `f:${child.docName}`}
              node={child}
              onOpenFile={onOpenFile}
              onNodeContextMenu={onNodeContextMenu}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export default FileExplorer;
