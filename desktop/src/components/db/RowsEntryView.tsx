import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../ui/icon";
import { ResultTable } from "./ResultTable";
import { QuerySettings } from "./QuerySettings";
import { thousands } from "../../lib/db";
import { guessTable } from "../../lib/resultExport";
import { statsText, statsTitle } from "../../lib/dbStats";
import { dbApi, dbSourceOf, type ExportFileOut, type ExportProgress } from "../../lib/dbApi";
import { listen } from "../../lib/tauri";
import { activeExportId, cancelResultExport, exportResultFile, reSortOnServer } from "../../lib/dbResultActions";
import { useColumnZh } from "../../lib/dbColumnZh";
import { connOf, loadMore, type ResultEntry, type SqlTab } from "../../lib/dbStore";

/**
 * 有行数据的结果。`dbms_sql.return_result` 可能一次带回多个结果集，
 * 多于一的时候表格上方给一排小标签切换（只有一个就不占那行高度）。
 *
 * 这里还挂着 A4 的流式导出（进度 + 落盘结果）与 A3 的「让数据库重排」入口。
 */
export function RowsEntryView({ tab, entry, isLast, tabs }: { tab: SqlTab; entry: ResultEntry; isLast: boolean; tabs: ReactNode }) {
  const [pick, setPick] = useState(0);
  /** 导出进行中：`rows` 是后端每 5000 行推过来的进度。 */
  const [job, setJob] = useState<{ rows: number } | null>(null);
  /** 导出完成后的落盘信息（路径 + 行数 + 是否截断）。 */
  const [saved, setSaved] = useState<ExportFileOut | null>(null);
  const busy = job !== null;
  const exportLock=useRef(false);
  const sets = entry.sets ?? [];
  const at = Math.min(pick, Math.max(0, sets.length - 1));
  const set = sets.length > 0 ? sets[at] : null;
  const columns = set?.columns ?? entry.columns;
  const rows = set?.rows ?? entry.rows;
  /** 隐式结果集取到上限还有剩：不能续取，只能调大行数重跑。 */
  const truncated = !!set?.hasMore;
  /** 列名 → NC 中文名。查不到（非 NC 库 / 算出来的列）时表头照旧显示类型。 */
  const zh = useColumnZh(tab.connId, entry.sql, columns);

  useEffect(() => {
    if (!busy) return;
    let dead = false;
    let un: (() => void) | undefined;
    // 按「连接 + 导出实例」过滤：同一条连接上两个结果标签各导一份时不能串数字
    listen<ExportProgress>("db:export-progress", (p) => {
      if (dead || p.id !== tab.connId || p.exportId !== activeExportId(tab.id)) return;
      setJob({ rows: p.rows });
    })
      .then((f) => {
        if (dead) f();
        else un = f;
      })
      .catch(() => undefined);
    return () => {
      dead = true;
      un?.();
    };
  }, [busy, tab.connId, tab.id]);

  const onExportFile = async (format: "csv" | "tsv" | "insert") => {
    if(exportLock.current) return;
    exportLock.current=true;setSaved(null);
    setJob({ rows: 0 });
    try {
      setSaved(await exportResultFile(tab.id, entry.sql, format, guessTable(entry.sql)));
    } finally {
      exportLock.current=false;setJob(null);
    }
  };

  const subbar =
    sets.length > 1 || job || saved ? (
      <>
        {sets.length > 1 && (
          <div className="dbx-settabs" role="tablist" aria-label="结果集">
            {sets.map((s, i) => (
              <button
                key={i}
                type="button"
                role="tab"
                className="dbx-settab"
                data-on={i === at || undefined}
                title={`结果集 ${i + 1}：${thousands(s.rows.length)} 行`}
                onClick={() => setPick(i)}
              >
                结果集 {i + 1}
                <span className="dbx-cnt">
                  {thousands(s.rows.length)}
                  {s.hasMore ? "+" : ""}
                </span>
              </button>
            ))}
          </div>
        )}
        {(job || saved) && (
          <div className="dbx-exportbar" role="status">
            {job ? (
              <>
                <Icon name="spinner" size={12} />
                正在导出（后端边读边写）：已写 <b>{thousands(job.rows)}</b> 行…
                <button type="button" className="dbx-lk" onClick={() => cancelResultExport(tab.id)}>
                  取消
                </button>
              </>
            ) : (
              saved && (
                <>
                  <Icon name={saved.canceled ? "alertTriangle" : "check"} size={12} />
                  {saved.canceled ? "已取消导出 · 已写 " : "已导出 "}
                  <b>{thousands(saved.rows)}</b> 行 · {fmtBytes(saved.bytes)} ·{" "}
                  <span className="dbx-mono" title={saved.path}>{saved.fileName}</span>
                  <button type="button" className="dbx-lk" onClick={() => void dbApi.revealExport(saved.path)}>
                    打开所在文件夹
                  </button>
                  {saved.truncated && <span className="bad">到了行数上限，文件不是全量</span>}
                </>
              )
            )}
          </div>
        )}
      </>
    ) : undefined;

  return (
    <div className="dbx-rset">
      <ResultTable
        key={at}
        tabs={tabs}
        running={tab.running}
        subbar={subbar}
        settings={<QuerySettings tab={tab} />}
        columns={columns}
        rows={rows}
        table={guessTable(entry.sql)}
        layoutKey={`${tab.connId}:${guessTable(entry.sql) || columns.map(c=>c.name).join("|")}`}
        snapshot={{source:dbSourceOf(connOf(tab.connId)),sql:entry.sql,at:entry.completedAt ?? Date.now(),complete:sets.length ? !truncated : !entry.hasMore,columns,rows}}
        meta={
          <>
            {sets.length > 1 && <>第 {at + 1}/{sets.length} 个结果集 · </>}
            {entry.ms} ms
            {truncated ? " · 到行数上限" : entry.hasMore && !sets.length ? " · 还有更多" : ""}
            {statsText(entry.stats) && (
              <>
                {" · "}
                <span className="dbx-stats" title={statsTitle(entry.stats) ?? undefined}>
                  {statsText(entry.stats)}
                </span>
              </>
            )}
          </>
        }
        onServerSort={(col, dir) => void reSortOnServer(tab.id, entry.sql, columns[col]?.name ?? "", dir)}
        onExportFile={(f) => void onExportFile(f)}
        zh={zh}
        foot={
          <div className="dbx-rfoot">
            <span>已取 {thousands(rows.length)} 行</span>
            {entry.hasMore && !sets.length && (
              <button
                type="button"
                className="dbx-lk"
                disabled={entry.loadingMore || !isLast || tab.running}
                title={isLast ? "" : "这条会话上后来又执行过别的语句，游标已换掉：重新执行这条再加载"}
                onClick={() => void loadMore(tab.id, entry.id)}
              >
                {entry.loadingMore ? "加载中…" : `加载下 ${tab.maxRows} 行`}
              </button>
            )}
            {truncated && (
              <span className="dbx-muted">
                结果集还有更多：把「每次取」调大后重新执行（右上齿轮；隐式结果集不能接着往下取）
              </span>
            )}
            <span className="dbx-sp" />
          </div>
        }
      />
    </div>
  );
}

/** 文件大小：导出结果那一行用（几十 KB 到几百 MB 都要好读）。 */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
