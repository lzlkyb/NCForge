import type { FileKind } from "../../lib/fileFormats";
import { WorkspaceGlyph } from "./WorkspaceGlyph";

export function TreeTypeMarker({ kind }: { kind: FileKind }) {
  return <span className="wb-tree-type" aria-hidden="true">
    {kind.badge
      ? <span className="wb-tree-type-badge" data-tone={kind.tone}>{kind.badge}</span>
      : <WorkspaceGlyph name={kind.icon} tone={kind.tone} />}
  </span>;
}
