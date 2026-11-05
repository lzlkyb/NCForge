import { baseName, dirName, joinPath, listDir, readFile, type DirItem } from "./workspace";
import { loadNcComponents } from "./ncManifest";
import { isUnderPath } from "./treeProjects";
import { visibleChildren, type HoistOpts, type TreeChild } from "./ncStructure";

export type PackageRoots = ReadonlyMap<string, readonly string[]>;
export interface PackageDir { relative: string; isPackage: boolean }
export type PackageIndex = PackageDir[] | null;
export type PackageIndexes = ReadonlyMap<string, PackageIndex>;
const indexedPath = (source: string, entry: PackageDir) => joinPath(source, entry.relative.replace(/\//g, "\\"));
export const isJavaSourceRoot = (path: string) => baseName(path).toLowerCase() !== "resources";

export function sourceForPath(roots: PackageRoots | undefined, path: string): string | undefined {
  return roots && [...roots.values()].flat().filter(root => isJavaSourceRoot(root) && isUnderPath(path, root))
    .sort((a, b) => b.length - a.length)[0];
}

export function packageLocation(source: string, index: PackageIndex, path: string): string | undefined {
  return index?.map(entry => indexedPath(source, entry))
    .filter(dir => isUnderPath(path, dir)).sort((a, b) => b.length - a.length)[0];
}

const roles = ["public", "private", "client", "test", "resources"];
const order = (path: string) => (roles.indexOf(baseName(path).toLowerCase()) + 6) % 6;
const key = (s: string) => s.toLowerCase();

function relativeParts(path: string): string[] | null {
  if (/^[\\/]|:/.test(path)) return null; // Eclipse /Project entries are dependencies.
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length && parts.every(p => p !== "." && p !== "..") ? parts : null;
}

/** Read metadata and directory parents only. Source contents are loaded when a row opens. */
export async function loadPackageRoots(root: string): Promise<string[]> {
  const [cp, components] = await Promise.all([
    readFile(joinPath(root, ".classpath")).then(f => f.text).catch(() => ""),
    loadNcComponents(root),
  ]);
  const xml = new DOMParser().parseFromString(cp, "application/xml");
  const paths = [...xml.querySelectorAll('classpath > classpathentry[kind="src"]')].map(n => n.getAttribute("path") ?? "");
  for (const c of components) {
    if (!c.name || /[\\/]/.test(c.name)) continue;
    paths.push(...c.roots.map(r => `${c.name}/${r}`), `${c.name}/resources`);
    for (const role of roles.slice(0, 4)) paths.push(`${c.name}/src/${role}`);
  }
  const listings = new Map<string, Promise<DirItem[]>>();
  const resolve = async (relative: string) => {
    const parts = relativeParts(relative);
    if (!parts) return null;
    let current = root;
    for (const part of parts) {
      let listing = listings.get(current);
      if (!listing) { listing = listDir(current).catch(() => []); listings.set(current, listing); }
      const dir = (await listing).find(i => i.isDir && key(i.name) === key(part));
      if (!dir) return null;
      current = joinPath(current, dir.name);
    }
    return current;
  };
  const found = new Set<string>();
  for (let i = 0; i < paths.length; i += 4) {
    for (const path of await Promise.all(paths.slice(i, i + 4).map(resolve))) if (path) found.add(path);
  }
  // Nested declarations remain reachable inside the outer root rather than being duplicated.
  return [...found].filter(path => ![...found].some(other => other !== path && isUnderPath(path, other)))
    .sort((a, b) => dirName(a).replace(/\\src$/i, "").localeCompare(dirName(b).replace(/\\src$/i, ""))
      || order(a) - order(b)
      || a.localeCompare(b));
}

export function packageChildren(dir: string, items: DirItem[], opts: HoistOpts, roots?: PackageRoots, indexes?: PackageIndexes): TreeChild[] {
  const children = visibleChildren(dir, items, opts);
  if (!roots) return children;
  const source = sourceForPath(roots, dir);
  if (source && indexes) {
    const index = indexes.get(source);
    if (index !== null && dir === source) {
      const packages = (index ?? []).map(entry => {
        const path = indexedPath(source, entry);
        return {
          dir: dirName(path),
          item: { name: baseName(path), isDir: true, size: 0 },
          label: entry.relative.replace(/[\\/]/g, entry.isPackage ? "." : "/"),
          kind: entry.isPackage ? "package" as const : "folder" as const,
        };
      });
      return [...packages, ...children.filter(child => !child.item.isDir)];
    }
    if (index && index.some(entry => entry.isPackage && key(indexedPath(source, entry)) === key(dir))) {
      return children.filter(child => !child.item.isDir);
    }
  }
  const owned = [...roots.values()].flat().filter(path => {
    const parent = opts.dirs[dirName(path)];
    return parent?.status !== "ok" || parent.items.some(i => i.isDir && key(i.name) === key(baseName(path)));
  });
  const regular = children.filter(({ dir: parent, item }) => !owned.some(p => key(p) === key(joinPath(parent, item.name))));
  return [...(roots.get(dir) ?? []).filter(path => owned.includes(path)).map(path => ({
    dir: dirName(path),
    item: { name: baseName(path), isDir: true, size: 0 },
    kind: "source" as const,
    label: path.slice(dir.length + 1).replace(/\\/g, "/"),
  })), ...regular];
}

export function packageCompact(roots: PackageRoots | undefined, path: string, indexes?: PackageIndexes): boolean {
  const source = sourceForPath(roots, path);
  if (source && indexes?.get(source)) return false;
  const owner = roots && [...roots].filter(([project]) => isUnderPath(path, project)).sort(([a], [b]) => b.length - a.length)[0];
  return !owner?.[1].length || owner[1].some(root => key(root) !== key(path)
    && baseName(root).toLowerCase() !== "resources" && isUnderPath(path, root));
}

export function packageDepthOffset(roots: PackageRoots | undefined, path: string, indexes?: PackageIndexes): number {
  if (!roots) return 0;
  for (const [project, group] of roots) for (const root of group) {
    if (!isUnderPath(path, root)) continue;
    const offset = 1 - root.slice(project.length).split(/[\\/]/).filter(Boolean).length;
    const projected = packageLocation(root, indexes?.get(root) ?? null, path);
    return offset + (projected ? 1 - projected.slice(root.length).split(/[\\/]/).filter(Boolean).length : 0);
  }
  return 0;
}
