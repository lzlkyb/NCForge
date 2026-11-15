import { useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/button";
import { toast } from "../ui/toast";
import { JavaTemplateManager } from "./JavaTemplateManager";
import { applyPasteImports } from "../../lib/javaPasteImports";
import { showJavaEditingDialog, useJavaEditingDialog, type JavaImportRequest } from "../../lib/javaEditingDialogStore";

export function JavaEditingDialogs() {
  const state = useJavaEditingDialog();
  if (state?.kind === "templates") return <JavaTemplateManager onClose={() => showJavaEditingDialog(null)} />;
  if (state?.kind === "imports") return <PasteImportChoices key={`${state.request.path}:${state.request.version}`} request={state.request} />;
  return null;
}

function PasteImportChoices({ request }: { request: JavaImportRequest }) {
  const [selected, setSelected] = useState<Record<string, string>>(() => Object.fromEntries(request.choices.map(choice => [choice.simple, choice.names.length === 1 ? choice.names[0].name : ""])));
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const submit = async () => {
    setBusy(true); setError("");
    try { const count = await applyPasteImports(request, Object.values(selected).filter(Boolean)); toast(`已补充 ${count} 个导入；尚未保存`, "success"); showJavaEditingDialog(null); }
    catch (reason) { setError(String(reason)); setBusy(false); }
  };
  return <Modal open ariaLabel="粘贴后补充导入" onClose={() => { if (!busy) showJavaEditingDialog(null); }} className="mx-4 w-full max-w-2xl rounded-[var(--r-dialog)] modal-surface p-5">
    <h3 className="mb-2 text-base font-semibold">粘贴后补充导入</h3>
    <p className="mb-4 text-sm text-muted-foreground">同名类请按来源选择。仅补充所选导入，NC 库依赖会按需载入，文件由你保存。</p>
    <div className="max-h-80 space-y-3 overflow-auto">{request.choices.map(choice => <label className="block text-sm" key={choice.simple}>{choice.simple}<select aria-label={`${choice.simple} 导入来源`} disabled={busy} className="input input-surface mt-1 w-full rounded-[var(--r-control)] border border-input bg-background/70 px-2 py-1.5" value={selected[choice.simple]} onChange={event => setSelected({ ...selected, [choice.simple]: event.target.value })}><option value="">暂不导入{choice.names.length > 1 ? "（存在同名类）" : ""}</option>{choice.names.map(item => <option value={item.name} key={item.name}>{item.name} · {item.source}</option>)}</select></label>)}</div>
    {request.notes.length > 0 && <p className="mt-3 text-xs text-muted-foreground">{request.notes.join("；")}</p>}
    {error && <p className="mt-3 text-sm text-destructive-ink" role="alert">{error}</p>}
    <div className="mt-4 flex justify-end gap-2"><Button variant="outline" size="sm" disabled={busy} onClick={() => showJavaEditingDialog(null)}>跳过</Button><Button size="sm" disabled={busy || !Object.values(selected).some(Boolean)} onClick={() => void submit()}>{busy ? "载入并补充…" : "补充所选导入"}</Button></div>
  </Modal>;
}
