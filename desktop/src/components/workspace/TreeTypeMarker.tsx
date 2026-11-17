import type { ReactNode } from "react";
import type { FileKind } from "../../lib/fileFormats";
import { WorkspaceGlyph } from "./WorkspaceGlyph";

const compactJava: Record<string, string> = {
  java: "J", "java-class": "C", "java-interface": "I", "java-enum": "E", "java-annotation": "@", "java-record": "R",
};

export function TreeTypeMarker({ kind, compact = false, overlay }: { kind: FileKind; compact?: boolean; overlay?: ReactNode }) {
  return <span className="wb-tree-type" data-glyph={!kind.badge || undefined} aria-hidden="true">
    {kind.badge
      ? <span className="wb-tree-type-badge" data-tone={kind.tone}>{(compact && compactJava[kind.id]) || kind.badge}</span>
      : <WorkspaceGlyph name={kind.icon} tone={kind.tone} />}
    {overlay}
  </span>;
}
