import { Icon } from "../ui/icon";
import type { DbError } from "../../lib/db";
import type { Cell } from "../../lib/dbApi";

export interface ConflictValue { name: string; before: Cell; current: Cell; after: Cell }

/**
 * 表页的状态条：写回冲突、连接失效、首次读取、查询失败。
 *
 * 抽成组件是因为这四块全是「一次性提示 + 一个下一步动作」，和 TableData 的数据流
 * 没有耦合；留在主文件里只会让它继续膨胀。
 */
export function TableDataStatus({ conflict, conflictValues, connectionError, saving, loading, hasData, errorText, onReloadConflict, onReconnect, onRetry }: {
  conflict: string;
  conflictValues: ConflictValue[];
  connectionError: DbError | null;
  saving: boolean;
  loading: boolean;
  hasData: boolean;
  errorText: string | null;
  /** 清掉冲突提示并重新读取（调用方负责先问「丢弃改动」）。 */
  onReloadConflict: () => void;
  onReconnect: () => void;
  onRetry: () => void;
}) {
  const text = (v: Cell) => v === null || v === undefined ? "NULL" : String(v);
  return (
    <>
      {conflict && (
        <div className="dbx-err" role="alert">
          {conflict}
          <button type="button" className="dbx-btn" disabled={saving || loading} onClick={onReloadConflict}>重新读取并处理冲突</button>
        </div>
      )}
      {conflict && conflictValues.length > 0 && (
        <div className="dbx-change-review">
          <table><thead><tr><th>字段</th><th>读取时原值</th><th>数据库当前值</th><th>拟写入</th></tr></thead>
            <tbody>{conflictValues.map(c => <tr key={c.name}><td>{c.name}</td><td>{text(c.before)}</td><td>{text(c.current)}</td><td>{text(c.after)}</td></tr>)}</tbody></table>
        </div>
      )}
      {connectionError && (
        <div className="dbx-err" role="alert">
          {connectionError.message}
          {connectionError.code === "session-lost"
            ? <button type="button" className="dbx-btn" disabled={saving || loading} onClick={onReconnect}>重新连接</button>
            : <button type="button" className="dbx-btn" disabled={saving || loading} onClick={onReloadConflict}>重新读取</button>}
        </div>
      )}
      {!hasData && !connectionError && <div className="dbx-empty"><Icon name="spinner" size={18} />读取中…</div>}
      {errorText && (
        // 失败不是终点：给一条可点的下一步，而不是只让用户对着错误文字重进页面。
        <div className="dbx-err">
          {errorText}
          <button type="button" className="dbx-lk" style={{ marginLeft: 8 }} disabled={loading} onClick={onRetry}>重试</button>
        </div>
      )}
    </>
  );
}
