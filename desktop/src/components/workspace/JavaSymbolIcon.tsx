import { WorkspaceGlyph } from "./WorkspaceGlyph";
import { javaSymbolKind } from "../../lib/treeFileKind";

export function JavaSymbolIcon({ kind }: { kind: number }) {
  const style = javaSymbolKind(kind);
  return <span className="wb-symbol-icon" data-kind={style.id} title={style.label}>
    <WorkspaceGlyph name={style.icon} tone={style.tone} />
  </span>;
}
