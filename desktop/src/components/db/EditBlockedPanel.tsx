import { Dialog, DialogHeader, DialogTitle } from "../ui/dialog";
import { toast } from "../ui/toast";
import { copyText } from "../../lib/utils";
import { diagnosticText, type EditDiagnostics } from "../../lib/editDiagnostics";

/**
 * 「为什么不能直接改」诊断面板。
 *
 * 工具条上一句「只读 · 认不出基表」说不清下一步；这里把判定链摊开：
 * 执行的 SQL、认出的基表、缺的主键列、不可编辑的列类型、连接只读状态。
 * 「复制诊断」给的是纯文本，用户可以直接贴进工单或问同事。
 */
export function EditBlockedPanel({ open, diag, onClose, onPick }: {
  open: boolean;
  diag: EditDiagnostics;
  onClose: () => void;
  /** 有手动指定基表/定位列的出口时才显示按钮。 */
  onPick?: () => void;
}) {
  const copy = () => void copyText(
    diagnosticText(diag),
    () => toast("诊断信息已复制", "success"),
    e => toast(`复制失败：${String(e)}`, "error"),
  );
  return (
    <Dialog open={open} onClose={onClose} ariaLabel="为什么不能直接改数据">
      <DialogHeader>
        <DialogTitle>为什么不能直接改数据</DialogTitle>
        <button type="button" className="dbx-btn ghost" onClick={onClose}>关闭</button>
      </DialogHeader>
      <div className="space-y-3 text-sm">
        <div className="rounded-[var(--r-card)] border border-border bg-muted/40 p-3">
          <div className="font-medium">{diag.reason || "当前结果可以编辑"}</div>
          {diag.next && <div className="mt-1 text-xs leading-relaxed text-muted-foreground">下一步：{diag.next}</div>}
        </div>
        <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1.5 text-xs">
          <dt className="text-muted-foreground">执行的 SQL</dt>
          <dd className="break-all font-mono">{diag.sql || "（空）"}</dd>
          <dt className="text-muted-foreground">基表</dt>
          <dd>{diag.table ? `${diag.table}${diag.alias ? `（别名 ${diag.alias}）` : ""}` : "未识别"}{diag.forced ? " · 已手动指定" : ""}</dd>
          <dt className="text-muted-foreground">行定位</dt>
          <dd>{diag.identity}{diag.keys.length ? ` · ${diag.keys.join("、")}` : ""}</dd>
          {diag.missing.length > 0 && <>
            <dt className="text-muted-foreground">缺少主键列</dt>
            <dd className="text-warning-ink">{diag.missing.join("、")}</dd>
          </>}
          <dt className="text-muted-foreground">连接只读</dt>
          <dd>{diag.readonly === null ? "尚未探测到" : diag.readonly ? "是" : "否"}</dd>
          {diag.detail && <>
            <dt className="text-muted-foreground">解析</dt>
            <dd>{diag.detail}</dd>
          </>}
        </dl>
        {diag.readonlyColumns.length > 0 && (
          <div className="text-xs">
            <div className="mb-1 text-muted-foreground">不可编辑的列</div>
            <ul className="max-h-32 space-y-0.5 overflow-auto">
              {diag.readonlyColumns.map(c => <li key={c.name}><span className="font-mono">{c.name}</span>：{c.why}</li>)}
            </ul>
          </div>
        )}
        {diag.risky && (
          <div className="rounded-[var(--r-card)] border border-warning/40 bg-warning/10 p-2 text-xs text-warning-ink">
            这条查询本身是关联/汇总结构。手动指定基表后，请确认结果里每一行仍能被所选的定位列唯一确定。
          </div>
        )}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="dbx-btn ghost" onClick={copy}>复制诊断</button>
        {onPick && <button type="button" className="dbx-btn ghost" onClick={onPick}>指定基表/定位列…</button>}
        <button type="button" className="dbx-btn pri" onClick={onClose}>知道了</button>
      </div>
    </Dialog>
  );
}
