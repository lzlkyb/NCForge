import type { ScanProgress } from "../../lib/svn";
import { TaskFeedback } from "../ui/TaskFeedback";

const operationLabels: Record<string, string> = {
  update: "正在更新工作副本…", commit: "正在提交所选文件…", revert: "正在备份并撤销改动…",
  resolve: "正在处理冲突…", auth: "正在验证 SVN 账号…",
};

export function SvnTaskFeedback({ root, fetching, scanned, busy, hasPrevious, startedAt }: {
  root: string; fetching: boolean; scanned: ScanProgress | null; busy: string | null; hasPrevious: boolean; startedAt?: number;
}) {
  const scan = !busy && fetching ? scanned : null;
  return <TaskFeedback active={!!busy || fetching} compact className="vc-task-feedback"
    operationKey={`${root}:${busy ?? "scan"}:${startedAt ?? ""}`} startedAt={startedAt}
    label={busy ? operationLabels[busy] ?? "正在处理版本控制操作…" : "正在扫描工作副本…"}
    detail={scan?.module ? `当前模块：${scan.module}` : !busy && hasPrevious ? "正在更新，现有清单为上次扫描结果。" : undefined}
    progress={scan ? { done: scan.total ? scan.done ?? 0 : scan.scanned, total: scan.total ?? undefined, unit: scan.total ? "个模块" : "条" } : undefined} />;
}
