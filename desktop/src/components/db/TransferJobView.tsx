import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { dbTransferApi } from "../../lib/dbTransferApi";
import type { TransferJob } from "../../lib/resultTransferJobs";
import { thousands } from "../../lib/db";

export const transferBytes = (n: number) => n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 ** 2).toFixed(1)} MiB`;
export function TransferJobView({ job }: { job: TransferJob }) {
  const p = job.progress, out = job.out, active = ["running", "cancelling"].includes(job.state);
  const title = job.state === "failed" ? "导出未完成" : job.state === "partial" ? "已停止或达到上限，保留部分结果" : job.state === "success" ? "文件已保存" : job.state === "cancelled" ? "导出已取消，未保存文件" : job.state === "cancelling" ? "正在停止导出…" : p.phase === "finalizing" ? "正在完成文件" : p.phase === "preparing" ? "正在准备导出" : "正在读取并写入";
  const percent = p.totalRows === undefined ? null : p.totalRows === 0 ? 100 : Math.min(100, p.rows / p.totalRows * 100);
  const open = async (reveal: boolean) => { try { if (out) await dbTransferApi.open(out.destinationToken, reveal); } catch (e) { toast(`打开失败：${String(e)}`, "error"); } };
  return <div className="dbx-transfer-job" role="status" aria-live="polite">
    <div className="dbx-transfer-job-icon" data-warning={job.state === "partial" || job.state === "failed" || undefined}><Icon name={active ? "spinner" : job.state === "success" ? "check" : "alertTriangle"} size={24} /></div>
    <h3>{title}</h3><p>{job.summary}</p>
    {active && <div className="dbx-transfer-progress-area"><div className="dbx-transfer-progress-label"><span>已写 {thousands(p.rows)}{p.totalRows !== undefined ? ` / ${thousands(p.totalRows)}` : " · 总量未知"} 行</span><b>{p.phase === "finalizing" ? "封装中" : percent === null ? "" : `${percent.toFixed(1)}%`}</b></div><div className="dbx-transfer-progress" role="progressbar" aria-label="结果导出进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined} data-unknown={percent === null || undefined}><span style={{ width: percent === null ? "30%" : `${percent}%` }} /></div>
      <div className="dbx-transfer-metrics"><span>{p.bytesKind === "buffered" ? `已处理 ${transferBytes(p.processedBytes ?? 0)}` : `已写 ${transferBytes(p.bytes)}`}</span><span>{(p.elapsedMs / 1000).toFixed(1)} 秒</span><span>{thousands(Math.round(p.rowsPerSec))} 行/秒</span><span>{p.bytesKind === "buffered" ? "封装后显示文件大小" : `写入 ${transferBytes(p.bytesPerSec)}/秒`}</span></div></div>}
    {job.error && <div className="dbx-transfer-error" role="alert">{job.error}<small>设置已保留，可选择其他保存位置或确认连接后重试。</small></div>}
    {job.notice && <div className="dbx-transfer-note">{job.notice}</div>}
    {out && <><dl className="dbx-transfer-file-info"><dt>文件</dt><dd>{out.fileName}</dd><dt>位置</dt><dd title={out.path}>{out.path}</dd><dt>实际输出</dt><dd>{thousands(out.rows)} 行 · {transferBytes(out.bytes)} · {(out.ms / 1000).toFixed(1)} 秒</dd><dt>完整性</dt><dd>{job.state === "partial" ? "部分结果，请勿作为全量数据使用" : "所选范围已保存"}</dd></dl><div className="dbx-transfer-file-actions"><button type="button" className="dbx-btn" onClick={() => void open(false)}><Icon name="file" size={14} />打开文件</button><button type="button" className="dbx-btn" onClick={() => void open(true)}><Icon name="folder" size={14} />所在文件夹</button><button type="button" className="dbx-btn ghost" onClick={() => void navigator.clipboard.writeText(out.path).then(() => toast("文件路径已复制", "success"), e => toast(`复制路径失败：${String(e)}`, "error"))}><Icon name="copy" size={14} />复制路径</button></div></>}
    {out?.warnings.length ? <div className="dbx-transfer-note">{out.warnings.map((w, i) => <p key={i}>{w}</p>)}</div> : null}
    {active && <p className="dbx-transfer-help">来源和设置已固定，可后台运行。查询调用结束或下一批次到达时响应停止请求。</p>}
    {job.state === "partial" && <p className="dbx-transfer-note">部分输出采用独立文件名，已完成的文件不会被停止操作覆盖。</p>}
  </div>;
}
