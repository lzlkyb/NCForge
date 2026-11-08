import { useMemo } from "react";
import { Icon } from "../ui/icon";
import { resultSqlState, resultTargetIssue, type ResultExecutionContext } from "../../lib/dbResultContext";
import { useDbSelector, useSqlDraft } from "../../lib/dbStore";

export function ResultContextNotice({ tabId, context }: { tabId: string; context?: ResultExecutionContext }) {
  const sql = useSqlDraft(tabId);
  const conn = useDbSelector(s => s.conns.find(c => c.id === context?.connId) ?? null);
  const schema = useDbSelector(s => context ? s.rt[context.connId]?.currentSchema ?? s.rt[context.connId]?.info?.schema : undefined);
  const state = useMemo(() => resultSqlState(context, sql), [context, sql]);
  const issue = resultTargetIssue(context, conn, schema);
  const message = state === "changed" ? "SQL 已修改，结果尚未更新" : state === "uncertain" ? "编辑区存在重复 SQL，无法确认对应语句；请通过「来源」核对执行时 SQL" : "";
  if (!issue && !message) return null;
  return <div className="dbx-result-context-note" role="status"><Icon name="info" size={14}/><span>{[message, issue].filter(Boolean).join(" · ")}</span></div>;
}
