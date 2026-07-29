import type { AtelierDocNameEntry } from "../../electron/atelier";

export interface TreeFolder {
  type: "folder";
  name: string;
  path: string;
  children: TreeNode[];
}

export interface TreeFile {
  type: "file";
  name: string;
  docName: string;
}

export type TreeNode = TreeFolder | TreeFile;

/** Classes are packaged via dot segments (Demo.Utils.Helper.cls -> Demo/Utils/Helper.cls); CSP files use real
 * "/" paths; routines (.mac/.int/.inc) have no InterSystems-defined nesting, so they stay flat. */
function splitSegments(docName: string): string[] {
  if (docName.toLowerCase().endsWith(".cls")) {
    const withoutExt = docName.slice(0, -4);
    const parts = withoutExt.split(".");
    const className = parts.pop();
    return className ? [...parts, `${className}.cls`] : [docName];
  }
  if (docName.includes("/")) {
    return docName.split("/");
  }
  return [docName];
}

export function buildDocumentTree(docs: AtelierDocNameEntry[]): TreeNode[] {
  const root: TreeFolder = { type: "folder", name: "", path: "", children: [] };
  // Looking up a folder by scanning `current.children` (as before) is O(siblings) per segment, and a
  // package with thousands of same-level classes/subfolders made that quadratic. A path is unique
  // across the whole tree (it's just the chain of segment names from the root), so a single global
  // map gives the same merge behavior as the old scoped-by-parent lookup in O(1) instead.
  const folderIndex = new Map<string, TreeFolder>([["", root]]);

  for (const doc of docs) {
    const segments = splitSegments(doc.name);
    let current = root;
    let currentPath = "";
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i];
      currentPath = currentPath ? `${currentPath}.${segment}` : segment;
      let folder = folderIndex.get(currentPath);
      if (!folder) {
        folder = { type: "folder", name: segment, path: currentPath, children: [] };
        folderIndex.set(currentPath, folder);
        current.children.push(folder);
      }
      current = folder;
    }
    current.children.push({ type: "file", name: segments[segments.length - 1], docName: doc.name });
  }

  sortTree(root);
  return root.children;
}

function sortTree(folder: TreeFolder) {
  folder.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const child of folder.children) {
    if (child.type === "folder") sortTree(child);
  }
}
