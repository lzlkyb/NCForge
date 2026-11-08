import type { ImportFail } from "../../lib/dbApi";

/** 导入进行到哪一步。`canceling` 并进来是因为它本来就是「这一轮的状态」的一部分。 */
export interface ImportBusy {
  done: number;
  total: number;
  canceling: boolean;
}

/** 导入结果摘要：即使中途抛错也会给（已写入的批不会因为异常消失）。 */
export interface ImportResult {
  inserted: number;
  failed: ImportFail[];
  ms: number;
  canceled: boolean;
}

/**
 * 导入对话框下方的「进度 / 错误 / 结果」三块。
 *
 * 抽出来只为一件事：**结果必须一直看得见**。失败行号要能对回文件，所以原文照列；
 * 只显示"失败 3 行"的话，用户还得自己去猜是哪三行。
 */
export function ImportProgress({ busy, err, out }: {
  busy: ImportBusy | null;
  err: string | null;
  out: ImportResult | null;
}) {
  return (
    <>
      {busy && (
        <div className="dbx-hint" style={{ marginTop: 8 }}>
          {busy.canceling
            ? "已请求取消，等当前批写完就停（已经在飞的那批必须写完，否则不知道结果）…"
            : `正在写：${busy.done} / ${busy.total} 行…（点「取消导入」会在当前批写完后停下）`}
        </div>
      )}
      {err && <div className="dbx-err" style={{ marginTop: 8 }}>{err}</div>}
      {out && (
        <div className="dbx-hint" style={{ marginTop: 8 }}>
          <div style={{ color: "hsl(var(--foreground))" }}>
            {out.canceled ? "已取消 · 已写进 " : "写进 "}
            <b>{out.inserted}</b> 行 · {(out.ms / 1000).toFixed(1)}s
            {out.failed.length > 0 && (
              <b style={{ color: "hsl(var(--destructive-ink))" }}> · 失败 {out.failed.length} 行</b>
            )}
          </div>
          {out.failed.length > 0 && (
            <div className="dbx-mono" style={{ maxHeight: 120, overflow: "auto", marginTop: 4 }}>
              {out.failed.slice(0, 20).map((f) => (
                <div key={`${f.line}:${f.error}`}>
                  第 {f.line} 行：{f.error}
                </div>
              ))}
              {out.failed.length > 20 && <div>……还有 {out.failed.length - 20} 条</div>}
            </div>
          )}
        </div>
      )}
    </>
  );
}
