import type { WorkspaceSession } from "./workspaceSession";

export type EditorGroupId = "left" | "right";
export interface EditorGroups {
  left: string[]; right: string[];
  leftActive: string | null; rightActive: string | null;
  focused: EditorGroupId; ratio: number; recent: string[];
}
export const emptyEditorGroups = (): EditorGroups => ({ left: [], right: [], leftActive: null, rightActive: null, focused: "left", ratio: .5, recent: [] });
export const activeOfGroup = (groups: EditorGroups, group: EditorGroupId) => group === "left" ? groups.leftActive : groups.rightActive;
const keyOf = (group: EditorGroupId) => group === "left" ? "leftActive" : "rightActive";

/** Keep one canonical model per file while allowing a view in either or both groups. */
export function reconcileEditorGroups(previous: WorkspaceSession, next: WorkspaceSession, changed: Partial<WorkspaceSession>): WorkspaceSession {
  const paths = next.tabs.map(t => t.path), canonical = (path: string | null | undefined) => paths.find(p => p.toLowerCase() === path?.toLowerCase()) ?? null;
  const source = "editorGroups" in changed && next.editorGroups ? next.editorGroups : next.root !== previous.root ? emptyEditorGroups() : next.editorGroups ?? emptyEditorGroups();
  const clean = (list: string[]) => [...new Set(list.map(canonical).filter((p): p is string => !!p))];
  const groups: EditorGroups = { ...source, left: clean(source.left), right: clean(source.right), recent: clean(source.recent) };
  if ("splitPath" in changed && !("editorGroups" in changed)) {
    const right = canonical(next.splitPath);
    if (right) { if (!groups.right.includes(right)) groups.right.push(right); groups.rightActive = right; }
    else { groups.left = [...new Set([...groups.left, ...groups.right])]; groups.right = []; groups.rightActive = null; groups.focused = "left"; }
  }
  if ("activePath" in changed && !("editorGroups" in changed)) {
    const active = canonical(next.activePath);
    groups[keyOf(groups.focused)] = active;
    if (active && !groups[groups.focused].includes(active)) groups[groups.focused].push(active);
  }
  for (const path of paths) if (!groups.left.includes(path) && !groups.right.includes(path)) groups.left.push(path);
  groups.leftActive = canonical(groups.leftActive) && groups.left.includes(groups.leftActive!) ? groups.leftActive : groups.left[0] ?? null;
  groups.rightActive = canonical(groups.rightActive) && groups.right.includes(groups.rightActive!) ? groups.rightActive : groups.right[0] ?? null;
  if (!groups.right.length) groups.focused = "left";
  else if (!groups.left.length) groups.focused = "right";
  const activePath = activeOfGroup(groups, groups.focused);
  if (activePath) groups.recent = [activePath, ...groups.recent.filter(p => p !== activePath)].slice(0, 60);
  groups.ratio = Number.isFinite(groups.ratio) ? Math.max(.25, Math.min(.75, groups.ratio)) : .5;
  const identical = next.editorGroups && JSON.stringify(groups) === JSON.stringify(next.editorGroups);
  return { ...next, editorGroups: identical ? next.editorGroups : groups, activePath, splitPath: groups.rightActive };
}

export function selectGroupFile(groups: EditorGroups, group: EditorGroupId, path: string): EditorGroups {
  return { ...groups, [group]: groups[group].includes(path) ? groups[group] : [...groups[group], path], [keyOf(group)]: path, focused: group };
}
export function moveGroupFile(groups: EditorGroups, source: EditorGroupId, path: string): EditorGroups {
  const target = source === "left" ? "right" : "left", rest = groups[source].filter(p => p !== path);
  return { ...selectGroupFile(groups, target, path), [source]: rest, [keyOf(source)]: activeOfGroup(groups, source) === path ? rest[0] ?? null : activeOfGroup(groups, source) };
}
export function removeGroupView(groups: EditorGroups, group: EditorGroupId, path: string): EditorGroups {
  const rest = groups[group].filter(p => p !== path);
  return { ...groups, [group]: rest, [keyOf(group)]: activeOfGroup(groups, group) === path ? rest[0] ?? null : activeOfGroup(groups, group) };
}
export function closeRightGroup(groups: EditorGroups): EditorGroups {
  return { ...groups, left: [...new Set([...groups.left, ...groups.right])], leftActive: groups.focused === "right" ? groups.rightActive : groups.leftActive, right: [], rightActive: null, focused: "left" };
}
export function swapEditorGroups(groups: EditorGroups): EditorGroups {
  return { ...groups, left: groups.right, right: groups.left, leftActive: groups.rightActive, rightActive: groups.leftActive, focused: groups.focused === "left" ? "right" : "left", ratio: 1 - groups.ratio };
}
