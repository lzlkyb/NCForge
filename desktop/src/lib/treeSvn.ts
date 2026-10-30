import type { ChangeItem, StatusLetter } from "./svn";

export const pathKey = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
export function treeSvnIndex(root: string, items: ChangeItem[]) {
  const base = pathKey(root);
  const files = new Map<string, StatusLetter>();
  const directories = new Map<string, number>();
  for (const item of items) {
    const path = pathKey(item.path);
    if (item.ignored || item.isDir || !path.startsWith(base + "/") || files.has(path)) continue;
    files.set(path, item.letter);
    let parent = path.slice(0, path.lastIndexOf("/"));
    while (parent === base || parent.startsWith(base + "/")) {
      directories.set(parent, (directories.get(parent) ?? 0) + 1);
      if (parent === base) break;
      parent = parent.slice(0, parent.lastIndexOf("/"));
    }
  }
  return { files, directories };
}
