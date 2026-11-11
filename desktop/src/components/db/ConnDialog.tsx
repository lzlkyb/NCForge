import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { Icon } from "../ui/icon";
import { ConnManualForm } from "./ConnManualForm";
import { PropImportPane } from "./ConnImportPanes";
import { PropsFileImportPane } from "./PropsFileImportPane";
import { OtherToolsPane } from "./ConnOtherToolsPane";
import { closeConnDialog, openConnDialog, useConnOf, useDbSelector } from "../../lib/dbStore";

const TABS = [
  { key: "manual", label: "手动填写" },
  { key: "prop", label: "从 NC prop.xml 导入" },
  { key: "file", label: "导入 .properties" },
  { key: "other", label: "从其他工具导入" },
] as const;

/**
 * 新建 / 编辑连接。
 *
 * 编辑已有连接时只给「手动填写」一页；新建时三种来源任选。
 */
export function ConnDialog() {
  const dialog = useDbSelector((s) => s.dialog);
  const editing = useConnOf(dialog?.connId ?? null);
  return (
    <Modal keepMountedWhenInactive open={dialog !== null} onClose={closeConnDialog} className="modal-surface dbx-dlg dbx-conn-dialog" ariaLabel="数据库连接">
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
            <div className="tabs" role="tablist" aria-label="连接来源">
              {TABS.map((t, index) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={dialog.tab === t.key}
                  tabIndex={dialog.tab === t.key ? 0 : -1}
                  onKeyDown={event => {
                    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
                    const next = event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : step ? (index + step + TABS.length) % TABS.length : -1;
                    if (next < 0) return;
                    event.preventDefault();
                    openConnDialog(null, TABS[next].key);
                    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
                  }}
                  data-on={dialog.tab === t.key || undefined}
                  onClick={() => openConnDialog(null, t.key)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}
          <ConnectionPanels key={editing?.id ?? "new"} editing={editing} tab={dialog.tab} />
        </>
      )}
    </Modal>
  );
}

function ConnectionPanels({ editing, tab }: { editing: Parameters<typeof ConnManualForm>[0]["conn"]; tab: string }) {
  const [visited, setVisited] = useState(() => new Set([editing ? "manual" : tab]));
  useEffect(() => { setVisited(current => new Set([...current, tab])); }, [tab]);
  const panels = { manual: <ConnManualForm conn={editing} />, prop: <PropImportPane />, file: <PropsFileImportPane />, other: <OtherToolsPane /> };
  return <>{Object.entries(panels).filter(([key]) => visited.has(key)).map(([key, panel]) =>
    <div key={key} hidden={(editing ? "manual" : tab) !== key} style={{ display: (editing ? "manual" : tab) === key ? "contents" : "none" }}>{panel}</div>
  )}</>;
}
