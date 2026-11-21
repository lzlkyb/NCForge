import type { ImportResult } from "../../hooks/useImportRun";

/**
 * 导入对话框下方的「进度 / 错误 / 结果」三块。
 *
 * 抽出来只为一件事：**结果必须一直看得见**。失败行号要能对回文件，所以原文照列；
 * 只显示"失败 3 行"的话，用户还得自己去猜是哪三行。
 *
 * 列表只显示前 20 条，但导出给的是**后端回传的全部明细**——所以按钮上带条数，
 * 且截断时要明说，不能让用户以为坏行就这些。
 */
export function ImportProgress({ err, out, onExportFailed }: {
  err: string | null;
  out: ImportResult | null;
  /** 有失败明细时提供；不传就不显示导出按钮（纯展示场景）。 */
  onExportFailed?: () => void;
}) {
  const fails = out?.failed ?? [];
  return (
    <>
      {err && <div className="dbx-err" role="alert" style={{ marginTop: 8 }}>{err}</div>}
      {out && (
        <div className="dbx-hint" role="status" style={{ marginTop: 8 }}>
          <div style={{ color: "hsl(var(--foreground))" }}>
            {out.canceled ? "已取消 · 已写进 " : "写进 "}
            <b>{out.inserted}</b> 行 · {(out.ms / 1000).toFixed(1)}s
            {fails.length > 0 && (
              <b style={{ color: "hsl(var(--destructive-ink))" }}> · 失败 {fails.length} 行</b>
            )}
          </div>
          {out.inserted > 0 && <span className="dbx-muted">返回数据页后可重新查询查看本次写入。</span>}
          {fails.length > 0 && (
            <div className="dbx-mono" style={{ maxHeight: 120, overflow: "auto", marginTop: 4 }}>
              {fails.slice(0, 20).map((f) => (
                <div key={`${f.line}:${f.error}`}>
                  第 {f.line} 行：{f.error}
                </div>
              ))}
              {fails.length > 20 && <div>……还有 {fails.length - 20} 条</div>}
            </div>
          )}
          {fails.length > 0 && onExportFailed && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
              <button type="button" className="dbx-btn ghost" onClick={onExportFailed}>
                导出失败行（{fails.length} 条）
              </button>
              <span className="dbx-muted" style={{ fontSize: 11 }}>
                带原始各列与错误原因；改完删掉首尾两列即可再导
              </span>
            </div>
          )}
          {out.truncated && (
            // 后端每批最多回 200 条明细。不说清楚的话，导出文件看着像全的
            <div className="dbx-muted" style={{ fontSize: 11, marginTop: 4 }}>
              失败明细已超出每批回传上限，这里只有已回传的部分；建议先缩小数据范围再导一次。
            </div>
          )}
        </div>
      )}
    </>
  );
}
