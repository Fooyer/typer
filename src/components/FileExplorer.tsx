import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { TreeNode } from "../utils/documentTree";

interface FileExplorerProps {
  nodes: TreeNode[];
  onOpenFile: (docName: string) => void;
  /** `selectedNodes` includes every node currently multi-selected (may just be `[node]`). */
  onNodeContextMenu?: (node: TreeNode, x: number, y: number, selectedNodes: TreeNode[]) => void;
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

// Fixed row height (not measured) so absolute-positioned rows always line up exactly — see the
// `height` set on each row below. Matches the old .file-tree-file/.file-tree-folder-label padding
// (2px top/bottom) plus a 12px line box at the sidebar's 12px font-size.
const ROW_HEIGHT = 22;
const INDENT_PX = 14;
// Extra rows rendered above/below the viewport so a fast scroll or key-repeat doesn't flash blank
// rows before the next paint catches up.
const OVERSCAN = 12;

interface Row {
  key: string;
  depth: number;
  node: TreeNode;
}

/**
 * Flattens the tree into just the rows that are actually visible given which folders are expanded.
 * Collapsed folders' children are never visited, so a namespace with thousands of classes tucked
 * under a handful of collapsed packages costs O(top-level items), not O(total documents) — the same
 * property the old recursive-JSX version had, just now computed once instead of re-rendered as DOM.
 */
function flattenVisible(nodes: TreeNode[], expanded: Set<string>, depth: number, out: Row[]) {
  for (const node of nodes) {
    if (node.type === "file") {
      out.push({ key: `f:${node.docName}`, depth, node });
    } else {
      out.push({ key: `d:${node.path}`, depth, node });
      if (expanded.has(node.path)) flattenVisible(node.children, expanded, depth + 1, out);
    }
  }
}

function FileExplorer({ nodes, onOpenFile, onNodeContextMenu }: FileExplorerProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const lastIndexRef = useRef<number | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  const rows = useMemo(() => {
    const out: Row[] = [];
    flattenVisible(nodes, expanded, 0, out);
    return out;
  }, [nodes, expanded]);

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    setViewportHeight(el.clientHeight);
    const observer = new ResizeObserver(([entry]) => setViewportHeight(entry.contentRect.height));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const handleScroll = useCallback(() => {
    setScrollTop(viewportRef.current?.scrollTop ?? 0);
  }, []);

  const toggleFolder = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // Ctrl/Cmd+click toggles one row in/out of the selection; Shift+click selects the visible range
  // since the last clicked row; a plain click collapses the selection to just that row and keeps
  // the old open-file/toggle-folder behavior — the same conventions as VS Code's explorer.
  const handleRowClick = useCallback(
    (event: React.MouseEvent, row: Row, index: number) => {
      if (event.ctrlKey || event.metaKey) {
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(row.key)) next.delete(row.key);
          else next.add(row.key);
          return next;
        });
        lastIndexRef.current = index;
        return;
      }
      if (event.shiftKey && lastIndexRef.current !== null) {
        const [from, to] = [lastIndexRef.current, index].sort((a, b) => a - b);
        setSelected(new Set(rows.slice(from, to + 1).map((r) => r.key)));
        return;
      }
      setSelected(new Set([row.key]));
      lastIndexRef.current = index;
      if (row.node.type === "file") onOpenFile(row.node.docName);
      else toggleFolder(row.node.path);
    },
    [rows, onOpenFile, toggleFolder],
  );

  const handleRowContextMenu = useCallback(
    (event: React.MouseEvent, row: Row) => {
      if (!onNodeContextMenu) return;
      event.preventDefault();
      event.stopPropagation();
      if (selected.has(row.key) && selected.size > 1) {
        const selectedNodes = rows.filter((r) => selected.has(r.key)).map((r) => r.node);
        onNodeContextMenu(row.node, event.clientX, event.clientY, selectedNodes);
      } else {
        setSelected(new Set([row.key]));
        onNodeContextMenu(row.node, event.clientX, event.clientY, [row.node]);
      }
    },
    [onNodeContextMenu, rows, selected],
  );

  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(
    rows.length,
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN,
  );
  const visible = rows.slice(startIndex, endIndex);

  return (
    <div className="file-tree-viewport" ref={viewportRef} onScroll={handleScroll}>
      <div className="file-tree" style={{ height: rows.length * ROW_HEIGHT }}>
        {visible.map((row, i) => (
          <FileTreeRow
            key={row.key}
            row={row}
            index={startIndex + i}
            top={(startIndex + i) * ROW_HEIGHT}
            expanded={row.node.type === "folder" && expanded.has(row.node.path)}
            selected={selected.has(row.key)}
            onRowClick={handleRowClick}
            onRowContextMenu={handleRowContextMenu}
          />
        ))}
      </div>
    </div>
  );
}

const FileTreeRow = memo(function FileTreeRow({
  row,
  index,
  top,
  expanded,
  selected,
  onRowClick,
  onRowContextMenu,
}: {
  row: Row;
  index: number;
  top: number;
  expanded: boolean;
  selected: boolean;
  onRowClick: (event: React.MouseEvent, row: Row, index: number) => void;
  onRowContextMenu: (event: React.MouseEvent, row: Row) => void;
}) {
  const { node, depth } = row;
  const style = { top, height: ROW_HEIGHT, paddingLeft: depth * INDENT_PX + 4 };
  const className =
    `file-tree-row ${node.type === "file" ? "file-tree-file" : "file-tree-folder-label"}` +
    (selected ? " selected" : "");

  if (node.type === "file") {
    return (
      <div
        className={className}
        style={style}
        onClick={(event) => onRowClick(event, row, index)}
        onContextMenu={(event) => onRowContextMenu(event, row)}
        title={node.docName}
      >
        <span className="file-tree-icon">{fileIcon(node.name)}</span>
        {node.name}
      </div>
    );
  }

  return (
    <div
      className={className}
      style={style}
      onClick={(event) => onRowClick(event, row, index)}
      onContextMenu={(event) => onRowContextMenu(event, row)}
    >
      <span className="file-tree-icon">{expanded ? "📂" : "📁"}</span>
      {node.name}
    </div>
  );
});

export default FileExplorer;
