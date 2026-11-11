import { useMemo, type CSSProperties } from "react";
import type { SqlLanguage } from "sql-formatter";
import { highlightedSql } from "../../lib/sqlHighlight";
import { SQL_ANALYSIS_LIMIT } from "../../lib/sqlScope";
import "../../lib/sql-highlight.css";

/** Span text children preserve the exact SQL and escape database/user content. */
export function SqlHighlightedText({ text, dialect = "sql" }: { text: string; dialect?: SqlLanguage }) {
  const tokens = useMemo(() => text.length > SQL_ANALYSIS_LIMIT ? null : highlightedSql(text, dialect), [text, dialect]);
  // Huge pastes remain readable plain text instead of creating tens of thousands of React nodes.
  if (!tokens) return <>{text}</>;
  return <>{tokens.map(token => token.kind === "space" ? token.text : <span key={token.start} className={`sql-token sql-${token.kind}`} data-sql-kind={token.kind}
    style={{ "--sql-color": `var(--sql-${token.kind}-color)` } as CSSProperties}>{token.text}</span>)}</>;
}
