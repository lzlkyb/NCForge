import type { CSSProperties, ReactElement } from "react";
import { TreeDirRow, TreeFileRow } from "./TreeRow";
import { ActiveTreeFileRow } from "./TreeActivePath";

/** Batch fixed-height siblings so a large directory needs only a few rendering boundaries. */
export function treeRowChunks(rows: ReactElement[]) {
  if (rows.length < 100) return rows;
  const result: ReactElement[] = [];
  let chunk: ReactElement[] = [];
  const flush = () => {
    if (!chunk.length) return;
    result.push(<div key={`chunk-${chunk[0].key}`} className="wb-tree-row-chunk" role="presentation"
      style={{ "--wb-tree-row-count": chunk.length } as CSSProperties}>{chunk}</div>);
    chunk = [];
  };
  for (const row of rows) {
    // Nested branches and inline editors retain their natural, variable height.
    if (row.type !== TreeDirRow && row.type !== TreeFileRow && row.type !== ActiveTreeFileRow) { flush(); result.push(row); continue; }
    chunk.push(row);
    if (chunk.length === 50) flush();
  }
  flush();
  return result;
}
