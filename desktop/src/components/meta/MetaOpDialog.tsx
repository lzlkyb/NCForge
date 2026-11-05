import { type ReactNode, useRef, useState } from "react";
import { bmfEditPreview, bmfEditSave, type BmfEditOp } from "../../lib/bmf";
import { toast } from "../ui/toast";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogTitle } from "../ui/dialog";

/**
 * 元数据编辑弹框的统一外壳：**先预览 diff、再保存**。
 *
 * 表单与 ops 由调用方给：任何输入变化都会让 `ops` 变化，旧预览自动失效；
 * 保存时后端再做 SHA-256 冲突检查与备份。子类弹框只负责「把表单翻译成 ops」。
 */
export function MetaOpDialog({
  title,
  ariaLabel,
  path,
  sha,
  ops,
  valid,
  onClose,
  onSaved,
  onReload,
  children,
}: {
  title: ReactNode;
  ariaLabel: string;
  path: string;
  sha: string;
  ops: BmfEditOp[];
  valid: boolean;
  onClose: () => void;
  onSaved: () => void;
  /** SHA 冲突时重新加载组件（关闭弹框并刷新详情）。 */
  onReload?: () => void;
  children: ReactNode;
}) {
  const [diff, setDiff] = useState<string | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ msg: string; conflict: boolean } | null>(null);
  const previewSeq = useRef(0);

  const currentKey = JSON.stringify(ops);
  const previewFresh = diff != null && previewKey === currentKey;

  const preview = async () => {
    if (!valid) return;
    const seq = ++previewSeq.current;
    setBusy(true);
    setErr(null);
    try {
      const text = ops.length === 0 ? "没有变化。" : await bmfEditPreview(path, ops);
      if (seq !== previewSeq.current) return;
      setDiff(text);
      setPreviewKey(JSON.stringify(ops));
    } catch (e) {
      if (seq === previewSeq.current) setErr({ msg: String(e), conflict: false });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!valid) {
      toast("请先修正输入", "info");
      return;
    }
    if (!previewFresh) {
      toast("先点「预览 diff」，确认本次修改后再保存", "info");
      return;
    }
    if (ops.length === 0) {
      toast("没有需要保存的修改", "info");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await bmfEditSave(path, ops, sha);
      toast(r.changed ? `已保存${r.backup ? "（已备份）" : ""}` : "文件没有变化", "success");
      onSaved();
    } catch (e) {
      const msg = String(e);
      setErr({ msg, conflict: msg.includes("SHA-256") || msg.includes("外部修改") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} ariaLabel={ariaLabel} zIndex={1200}>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>

      {children}

      {err && (
        <div className="meta-error-box meta-dialog-error">
          <strong>{err.conflict ? "文件已被外部修改" : "操作失败"}</strong>
          <pre>{err.msg}</pre>
          {err.conflict && onReload && (
            <Button size="sm" variant="outline" onClick={onReload}>
              重新加载组件
            </Button>
          )}
        </div>
      )}

      {diff != null && (
        <pre className="meta-diff" aria-label="修改预览">
          {diff || "（无差异）"}
        </pre>
      )}

      <div className="mt-4 flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          取消
        </Button>
        <Button variant="outline" onClick={() => void preview()} disabled={busy || !valid}>
          预览 diff
        </Button>
        <Button onClick={() => void save()} disabled={busy || !valid || !previewFresh}>
          保存
        </Button>
      </div>
    </Dialog>
  );
}
