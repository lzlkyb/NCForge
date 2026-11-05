import { relativeTo } from "./compile";

export function tabPathLabels(root: string, tabs: readonly { name: string; path: string }[]): Map<string, string> {
  const groups = new Map<string, string[]>();
  for (const tab of tabs) {
    const key = tab.name.toLowerCase();
    const group = groups.get(key);
    if (group) group.push(tab.path);
    else groups.set(key, [tab.path]);
  }

  const labels = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const folders = group.map(path => relativeTo(root, path).split("/").slice(0, -1));
    const nc = folders.map(parts => parts[1]?.toLowerCase() === "src" && parts[2]
      ? `${parts[0]}/${parts[2]}` : "");
    group.forEach((path, index) => {
      if (nc[index] && nc.filter(label => label.toLowerCase() === nc[index].toLowerCase()).length === 1
        && nc.every(Boolean)) {
        labels.set(path, nc[index]);
        return;
      }
      const parts = folders[index];
      const others = folders.filter((_, i) => i !== index);
      let count = 1;
      const suffix = (dirs: string[], n: number) => dirs.slice(-n).join("/").toLowerCase();
      while (count <= parts.length && others.some(dirs => suffix(dirs, count) === suffix(parts, count))) count++;
      // A complete short path can itself be the suffix of another folder.
      labels.set(path, count > parts.length ? `./${parts.join("/")}` : parts.slice(-count).join("/"));
    });
  }
  return labels;
}
