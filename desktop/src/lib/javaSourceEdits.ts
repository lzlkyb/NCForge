import type { WorkspaceEditLike } from "./javaActions";

/** 合并同一快照上的成员生成结果；重复结果去重，重叠替换不能半应用。 */
export function mergeJavaSourceEdits(edits: WorkspaceEditLike[]): WorkspaceEditLike {
  const changes: NonNullable<WorkspaceEditLike["changes"]> = {};
  for (const edit of edits) {
    for (const [uri, list] of Object.entries(edit.changes ?? {})) changes[uri] = [...(changes[uri] ?? []), ...list];
    for (const doc of edit.documentChanges ?? []) changes[doc.textDocument.uri] = [...(changes[doc.textDocument.uri] ?? []), ...doc.edits];
  }
  const compare = (a: { line: number; character: number }, b: { line: number; character: number }) => a.line - b.line || a.character - b.character;
  for (const [uri, list] of Object.entries(changes)) {
    const unique = [...new Map(list.map(edit => [JSON.stringify(edit), edit])).values()].sort((a, b) => compare(a.range.start, b.range.start));
    const merged: typeof unique = [];
    for (const edit of unique) {
      const previous = merged[merged.length - 1];
      if (previous && compare(previous.range.end, edit.range.start) > 0) throw new Error("选中的代码动作包含重叠改动，请分别生成");
      if (previous && !compare(previous.range.start, previous.range.end) && !compare(previous.range.end, edit.range.start) && !compare(edit.range.start, edit.range.end)) previous.newText += edit.newText;
      else merged.push({ ...edit });
    }
    changes[uri] = merged;
  }
  return { changes };
}
