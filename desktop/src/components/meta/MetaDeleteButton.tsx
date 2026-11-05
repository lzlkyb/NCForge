import { useState, type ReactNode } from "react";
import { bmfEditSave } from "../../lib/bmf";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";

/**
 * 删除节点（实体/字段/枚举/枚举项/关系）。后端会先拒绝仍被引用的节点；
 * 这里把拒绝原因内联出来，而不是只闪一条 toast。
 */
export function MetaDeleteButton({
  path,
  sha,
  id,
  what,
  onDone,
  onReload,
}: {
  path: string;
  sha: string;
  id: string;
  /** 确认框里的说明，例如「字段 pk」 */
  what: string;
  onDone: () => void;
  onReload?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await bmfEditSave(path, [{ op: "deleteNode", id }], sha);
      toast(r.changed ? `已删除${r.backup ? "（已备份）" : ""}` : "文件没有变化", "success");
      setOpen(false);
      onDone();
    } catch (e) {
      const msg = String(e);
      setErr(msg);
      setOpen(false);
      if (msg.includes("SHA-256") || msg.includes("外部修改")) onReload?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="meta-link is-danger"
        onClick={() => {
          setErr(null);
          setOpen(true);
        }}
        disabled={busy}
      >
        <Icon name="trash" size={12} /> 删除
      </button>
      {err && (
        <div className="meta-error-box meta-inline-error">
          <strong>没有删除</strong>
          <pre>{err}</pre>
        </div>
      )}
      {open && (
        <ConfirmDialog
          zIndex={1300}
          variant="destructive"
          title={`删除${what}？`}
          description="仍被其它节点引用的对象会被后端拒绝；保存前会自动备份原文件。"
          confirmLabel="删除"
          onCancel={() => setOpen(false)}
          onConfirm={() => void run()}
        />
      )}
    </>
  );
}

/** 供 MetaDetails 里的小按钮复用（打开某个编辑弹框）。 */
export function MetaActionButton({
  icon,
  children,
  onClick,
}: {
  icon: "plus" | "edit";
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button type="button" className="meta-link" onClick={onClick}>
      <Icon name={icon} size={12} /> {children}
    </button>
  );
}
