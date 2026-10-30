import { Modal } from "../ui/Modal";
import { Icon } from "../ui/icon";
import { ConnManualForm } from "./ConnManualForm";
import { PropImportPane } from "./ConnImportPanes";
import { PropsFileImportPane } from "./PropsFileImportPane";
import { closeConnDialog, connOf, openConnDialog, useDb } from "../../lib/dbStore";

const TABS = [
  { key: "manual", label: "手动填写" },
  { key: "prop", label: "从 NC prop.xml 导入" },
  { key: "file", label: "导入 .properties" },
] as const;

/**
 * 新建 / 编辑连接。
 *
 * 编辑已有连接时只给「手动填写」一页；新建时三种来源任选。
 */
export function ConnDialog() {
  const { dialog } = useDb();
  const editing = dialog?.connId ? connOf(dialog.connId) : null;
  return (
    <Modal open={dialog !== null} onClose={closeConnDialog} className="modal-surface dbx-dlg" ariaLabel="数据库连接">
      {dialog && (
        <>
          <div className="hd">
            <Icon name="database" size={16} />
            {editing ? `编辑连接 · ${editing.name}` : "新建连接"}
            <span className="dbx-sp" />
            <button type="button" className="dbx-ibtn" aria-label="关闭" onClick={closeConnDialog}>
              <Icon name="close" size={14} />
            </button>
          </div>
          {!editing && (
            <div className="tabs" role="tablist">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={dialog.tab === t.key}
                  data-on={dialog.tab === t.key || undefined}
                  onClick={() => openConnDialog(null, t.key)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}
          {(editing || dialog.tab === "manual") && <ConnManualForm key={editing?.id ?? "new"} conn={editing} />}
          {!editing && dialog.tab === "prop" && <PropImportPane />}
          {!editing && dialog.tab === "file" && <PropsFileImportPane />}
        </>
      )}
    </Modal>
  );
}
