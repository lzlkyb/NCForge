import { memo } from "react";
import { WorkspaceGlyph } from "./WorkspaceGlyph";
import { getText } from "../../lib/editorStore";
import { javaTreeMembers } from "../../lib/javaTreeMembers";
import { javaKindOfSymbol, treeFileKind } from "../../lib/treeFileKind";

export const EditorTabTypeIcon = memo(function EditorTabTypeIcon({ path, name }: { path: string; name: string; mtimeMs?: number }) {
  const text = /\.java$/i.test(name) ? getText(path) : undefined;
  const types = text && text.length <= 512 * 1024 ? javaTreeMembers(path, text, true) : [];
  const kind = treeFileKind(name, types.length === 1 ? javaKindOfSymbol(types[0].kind) : undefined);
  return <span className="wb-symbol-icon" data-kind={kind.id} title={kind.label}>
    <WorkspaceGlyph name={kind.icon} tone={kind.tone} />
  </span>;
});
