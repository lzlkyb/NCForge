import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "../ui/Modal";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { LinkedProjectsPanel, type LinkedProjectsPanelHandle } from "./LinkedProjectsPanel";
import { closeLinkedDialog, useLinkedDialog } from "../../lib/linkedDialog";

/**
 * 「工程关联」弹框：把原来独占一个页签的依赖链 / 覆盖表 / 产物检查
 * 收进代码页，仅在从状态栏、问题面板或命令面板打开时存在。
 *
 * 关闭前有未保存的覆盖表草稿就拦一道（同「切换工作区」的口径）：草稿一关就没了，
 * 而用户往往只是顺手点了遮罩。三选一：保存并关闭 / 继续编辑 / 放弃改动并关闭。
 */
export function LinkedProjectsDialog() {
  const { open, section } = useLinkedDialog();
  const panelRef = useRef<LinkedProjectsPanelHandle>(null);
  const [dirty, setDirty] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) return;
    setDirty(false);
    setConfirmClose(false);
  }, [open]);

  const requestClose = useCallback(() => {
    if (dirty) {
      setConfirmClose(true);
      return;
    }
    closeLinkedDialog();
  }, [dirty]);

  const saveAndClose = async () => {
    setConfirmClose(false);
    setSaving(true);
    const ok = await panelRef.current?.save();
    setSaving(false);
    if (ok) closeLinkedDialog();
  };

  return (
    <>
      <Modal
        open={open}
        onClose={requestClose}
        className="lnk-dialog modal-surface"
        ariaLabel="工程关联"
      >
        <LinkedProjectsPanel
          ref={panelRef}
          active={open}
          section={section}
          onDirtyChange={setDirty}
          onClose={requestClose}
        />
      </Modal>
      <ConfirmDialog
        open={confirmClose}
        title="覆盖表还有未保存的改动"
        description="关闭后这份草稿就没了。保存会整表替换现有覆盖；放弃则保持上次保存的样子。"
        confirmLabel={saving ? "保存中…" : "保存并关闭"}
        cancelLabel="继续编辑"
        extraLabel="放弃改动并关闭"
        confirmDisabled={saving}
        zIndex={1100}
        onCancel={() => setConfirmClose(false)}
        onConfirm={() => void saveAndClose()}
        onExtra={() => {
          setConfirmClose(false);
          closeLinkedDialog();
        }}
      />
    </>
  );
}
