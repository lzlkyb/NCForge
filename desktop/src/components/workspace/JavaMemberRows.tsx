import type { CSSProperties } from "react";
import { JavaSymbolIcon } from "./JavaSymbolIcon";
import { TreeTypeMarker } from "./TreeTypeMarker";
import { TreeRowNote } from "./TreeRow";
import { javaSymbolKind } from "../../lib/treeFileKind";
import { treeRowId } from "../../lib/treeNav";
import type { TreeMembers, JavaTreeMember } from "../../lib/javaTreeMembers";

export function JavaMemberRows({ state, depth, selected, onJump }: {
  state: NonNullable<ReturnType<TreeMembers["get"]>>;
  depth: number;
  selected: string | null;
  onJump: (member: JavaTreeMember) => void;
}) {
  if (state.status !== "ready" || !state.rows.length) {
    const note = state.status === "loading" ? "正在读取 Java 成员…" : state.status === "error" ? "无法读取成员，收起后可重试。" : "未识别到声明";
    return <TreeRowNote padLeft={26 + depth * 14}>{note}</TreeRowNote>;
  }
  const parents = new Set(state.rows.map(member => member.parent));
  return <>{state.rows.map(member => {
    const kind = javaSymbolKind(member.kind);
    return <button key={member.id} id={treeRowId(member.id)} type="button" className="wb-row wb-member-row"
      data-file data-kind="member" role="treeitem" tabIndex={-1}
      aria-level={depth + member.depth + 1} aria-selected={selected === member.id}
      aria-expanded={parents.has(member.id) ? true : undefined}
      aria-description={`${kind.label}，第 ${member.line} 行`}
      data-selected={selected === member.id || undefined}
      title={`${member.name} · ${kind.label} · 第 ${member.line} 行`}
      style={{ "--wb-tree-pad": `${26 + (depth + member.depth) * 14}px` } as CSSProperties}
      onClick={() => onJump(member)}>
      {kind.badge ? <TreeTypeMarker kind={kind} /> : <JavaSymbolIcon kind={member.kind} />}
      <span className="wb-row-name">{member.name}</span>
    </button>;
  })}</>;
}
