import { type ReactNode, useRef, useState } from "react";
import { bmfEditPreview, bmfEditSave, type BmfEditOp } from "../../lib/bmf";
import { toast } from "../ui/toast";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogTitle } from "../ui/dialog";
import type { MetaStage } from "../../lib/metaDraft";

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
  inline = false,
  onStage,
  draftLabel,
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
  /** 同一条预览/SHA 写回链，也可停靠在属性检查器内。 */
  inline?: boolean;
  onStage?: MetaStage;
  draftLabel?: string;
}) {
  const [diff, setDiff] = useState<string | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ msg: string; conflict: boolean } | null>(null);
  const previewSeq = useRef(0);

  const currentKey = JSON.stringify({ path, sha, ops });
  const previewFresh = diff != null && previewKey === currentKey;

  const preview = async () => {
    if (!valid || busy) return;
    const seq = ++previewSeq.current;
    setBusy(true);
    setErr(null);
    try {
      const text = ops.length === 0 ? "没有变化。" : await bmfEditPreview(path, ops);
      if (seq !== previewSeq.current) return;
      setDiff(text);
      setPreviewKey(currentKey);
    } catch (e) {
      if (seq === previewSeq.current) setErr({ msg: String(e), conflict: false });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (busy) return;
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

  const stage = async () => {
    if (!onStage || !valid || busy) return;
    setBusy(true); setErr(null);
    try { if (await onStage(draftLabel ?? ariaLabel, ops)) onSaved(); }
    catch (error) { setErr({ msg: String(error), conflict: String(error).includes("外部修改") }); }
    finally { setBusy(false); }
  };

  const body = (
    <div className={inline ? "meta-inline-edit" : undefined} onKeyDown={(e) => {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      // 抽屉里的 Esc 只收起面板并保留输入；停靠编辑的 Esc 与「取消」一致。
      if (inline && !busy && e.key === "Escape" && !e.currentTarget.closest('[aria-modal="true"]')) {
        e.preventDefault(); e.stopPropagation(); onClose(); return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        e.stopPropagation();
        void (onStage ? stage() : previewFresh ? save() : preview());
      }
    }}>
      {inline ? <h3>{title}</h3> : <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>}
      <fieldset disabled={busy} className="meta-edit-fields">{children}</fieldset>

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
        <pre className={`meta-diff ${previewFresh ? "" : "is-stale"}`} aria-label="修改预览">
          {diff || "（无差异）"}
        </pre>
      )}
      {diff != null && !previewFresh && <p className="meta-note" role="status">输入已改变，请重新预览。</p>}

      <div className="mt-4 flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          取消
        </Button>
        {!onStage && <Button variant="outline" onClick={() => void preview()} disabled={busy || !valid}>
          预览 diff
        </Button>}
        <Button onClick={() => void (onStage ? stage() : save())} disabled={busy || !valid || (!onStage && !previewFresh)}>
          {onStage ? "加入草稿" : "保存"}
        </Button>
      </div>
    </div>
  );
  return inline ? body : (
    <Dialog open onClose={() => { if (!busy) onClose(); }} ariaLabel={ariaLabel} zIndex={1200}>{body}</Dialog>
  );
}
