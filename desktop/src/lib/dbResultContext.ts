import { dbSourceOf, type DbConn } from "./dbApi";

export interface SqlRunTarget {
  text: string; startLine: number; endLine?: number;
  editorVersion?: number; editorSql?: string; startOffset?: number; endOffset?: number;
}
export interface ResultExecutionContext {
  readonly connId: string;
  readonly source: string;
  readonly connectionKey: string;
  readonly schema?: string;
  readonly sql: string;
  readonly startedAt: number;
  readonly target?: Readonly<SqlRunTarget>;
}

/** Names and environment are labels; changing a database address/account changes the execution target. */
export const connectionKey = (conn: DbConn | null) => conn ? JSON.stringify([conn.url, conn.user, conn.engine, conn.source, conn.propDs]) : "";
export function captureResultContext(connId: string, conn: DbConn | null, schema: string | undefined, sql: string, target?: SqlRunTarget): ResultExecutionContext {
  return Object.freeze({ connId, source: dbSourceOf(conn), connectionKey: connectionKey(conn), schema, sql, startedAt: Date.now(),
    target: target ? Object.freeze({ ...target }) : undefined });
}
export function resultTargetIssue(context: ResultExecutionContext | undefined, conn: DbConn | null, schema: string | undefined): string | null {
  if (!context) return null;
  if (!conn) return "无法找到这份结果的原连接。已加载的数据仍可查看。";
  if (conn.id !== context.connId || connectionKey(conn) !== context.connectionKey) return "连接目标已变化。当前显示旧结果，请先核对连接，再重新执行 SQL。";
  if (context.schema !== undefined && schema !== context.schema) return `当前 schema 已变化；此结果来自 ${context.schema || "登录账号"}，请切回该 schema 或重新执行查询`;
  return null;
}

/** The editor supplies the executed range. Other statements can change without making this result stale. */
export function resultSqlState(context: ResultExecutionContext | undefined, current: string): "unchanged" | "changed" | "uncertain" | null {
  const target = context?.target;
  if (target?.editorSql === undefined || target.startOffset === undefined || target.endOffset === undefined) return null;
  const original = target.editorSql, start = target.startOffset, end = target.endOffset;
  if (original === current) return "unchanged";
  const fragment = original.slice(start, end);
  if (!fragment) return null;
  if (current.slice(start, end) === fragment) return "unchanged";
  let prefix = 0, suffix = 0;
  while (prefix < Math.min(original.length, current.length) && original[prefix] === current[prefix]) prefix++;
  while (suffix < Math.min(original.length, current.length) - prefix && original[original.length - suffix - 1] === current[current.length - suffix - 1]) suffix++;
  if (end <= prefix || start >= original.length - suffix) return "unchanged";
  const first = current.indexOf(fragment);
  if (first < 0) return "changed";
  // A unique unchanged statement can move when unrelated statements are inserted around it.
  // Ambiguous duplicate text does not justify claiming that a particular occurrence was edited.
  return original.indexOf(fragment) === original.lastIndexOf(fragment) && first === current.lastIndexOf(fragment) ? "unchanged" : "uncertain";
}
