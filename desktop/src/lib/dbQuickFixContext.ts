import { connOf, rtOf, sqlTabOf, type ResultEntry } from "./dbStore";
import { resultTargetIssue } from "./dbResultContext";

/**
 * 结果区「一键修复」的执行上下文：校验这条结果还对着它当初那条 SQL / 那个连接，
 * 并对齐编辑器里的原文（供 fix 定位 start/end 偏移用）。
 *
 * 返回 `null` = 上下文已漂移（连接、schema、SQL 任一项对不上），调用方应提示
 * 「请重新执行」而不是拿错位置改编辑器。
 *
 * 纯函数：不碰组件状态，方便在 SqlConsole 与潜在的其他入口之间复用。
 */
export function repairResultContext(entry: ResultEntry, tabId: string): { connId: string; editorSql: string; offset: number; tables: string[] } | null {
  const current = sqlTabOf(tabId);
  const target = entry.context?.target;
  const runtime = rtOf(current?.connId);
  if (!current?.connId || target?.editorSql === undefined || target.startOffset === undefined ||
      target.editorSql !== current.sql || target.editorSql.slice(target.startOffset, target.startOffset + entry.sql.length) !== entry.sql ||
      resultTargetIssue(entry.context, connOf(current.connId), runtime.currentSchema ?? runtime.info?.schema)) return null;
  return { connId: current.connId, editorSql: target.editorSql, offset: target.startOffset, tables: runtime.tables?.map(t => t.name) ?? [] };
}
