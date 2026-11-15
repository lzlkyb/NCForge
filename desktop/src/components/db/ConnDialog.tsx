import { useEffect, useRef, useState } from "react";
import { Modal } from "../ui/Modal";
import { Icon } from "../ui/icon";
import { ConnManualForm } from "./ConnManualForm";
import { PropImportPane } from "./ConnImportPanes";
import { PropsFileImportPane } from "./PropsFileImportPane";
import { OtherToolsPane } from "./ConnOtherToolsPane";
import { closeConnDialog, openConnDialog, useConnOf, useDbSelector } from "../../lib/dbStore";

const SOURCES = [
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
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const menu = useRef<HTMLDetailsElement>(null);
  const source = SOURCES.find(item => item.key === dialog?.tab);
  useEffect(() => {
    if (!dialog) { setFile(null); setSaving(false); }
  }, [dialog]);
  const dismiss = () => {
    if (menu.current?.open) {
      menu.current.open = false;
      menu.current.querySelector("summary")?.focus();
    } else if (!saving) closeConnDialog();
  };
  return (
    <Modal keepMountedWhenInactive open={dialog !== null} onClose={dismiss} className="modal-surface dbx-dlg dbx-conn-dialog" ariaLabel="数据库连接">
      {dialog && (
        <>
          <div className="hd">
            <Icon name="database" size={16} />
            <span className="dbx-conn-title">{editing ? `编辑连接 · ${editing.name}` : source?.label ?? "新建数据库连接"}</span>
            <span className="dbx-sp" />
            {!editing && (source ? (
              <button type="button" className="dbx-btn" onClick={() => openConnDialog(null)}>返回填写</button>
            ) : (
              <details className="dbx-conn-import" ref={menu} hidden={saving} onBlur={event => {
                if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
              }}>
                <summary className="dbx-btn" tabIndex={0}>导入 <Icon name="chevronDown" size={12} /></summary>
                <div className="dbx-conn-import-list">
                  {SOURCES.map(item => (
                    <button key={item.key} type="button" className="dbx-btn ghost" onClick={event => {
                      const menu = event.currentTarget.closest("details");
                      if (menu) menu.open = false;
                      if (item.key === "file") {
                        menu?.querySelector("summary")?.focus();
                        fileInput.current?.click();
                      } else openConnDialog(null, item.key);
                    }}>{item.label}</button>
                  ))}
                </div>
              </details>
            ))}
            <button type="button" className="dbx-ibtn" aria-label="关闭" disabled={saving} onClick={closeConnDialog}>
              <Icon name="close" size={14} />
            </button>
          </div>
          {!editing && <input type="file" ref={fileInput} hidden accept=".properties,.txt,.conf" onChange={event => {
            const selected = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (!selected) return;
            setFile(selected);
            openConnDialog(null, "file");
          }} />}
          <ConnectionPanels key={editing?.id ?? "new"} editing={editing} tab={dialog.tab} file={file} onSaving={setSaving} />
        </>
      )}
    </Modal>
  );
}

function ConnectionPanels({ editing, tab, file, onSaving }: { editing: Parameters<typeof ConnManualForm>[0]["conn"]; tab: string; file: File | null; onSaving: (saving: boolean) => void }) {
  const manual = useRef<HTMLDivElement>(null);
  const previous = useRef(tab);
  useEffect(() => {
    if (previous.current !== tab && tab === "manual") manual.current?.querySelector<HTMLInputElement>("[data-autofocus]")?.focus();
    else if (previous.current !== tab) manual.current?.parentElement?.querySelector<HTMLButtonElement>(".hd .dbx-btn")?.focus();
    previous.current = tab;
  }, [tab]);
  return <>
    <div ref={manual} hidden={tab !== "manual"} className="dbx-conn-manual"><ConnManualForm conn={editing} onSaving={onSaving} /></div>
    {tab === "prop" && <PropImportPane />}
    {tab === "file" && <PropsFileImportPane selectedFile={file} />}
    {tab === "other" && <OtherToolsPane />}
  </>;
}
