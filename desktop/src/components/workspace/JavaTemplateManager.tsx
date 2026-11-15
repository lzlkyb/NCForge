import { useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { BUILTIN_JAVA_TEMPLATES } from "../../lib/liveTemplates";
import { deleteJavaTemplate, saveJavaTemplate, useJavaTemplates, type JavaTemplate } from "../../lib/javaTemplateStore";

export function JavaTemplateManager({ onClose }: { onClose: () => void }) {
  const custom = useJavaTemplates();
  const [edit, setEdit] = useState<JavaTemplate>({ prefix: "", detail: "", body: "", enabled: true });
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const all = [...new Map([...BUILTIN_JAVA_TEMPLATES, ...custom].map(item => [item.prefix, item])).values()];
  const save = () => { try { saveJavaTemplate(edit); setError(""); setFeedback("模板已保存"); } catch (reason) { setError(String(reason)); setFeedback(""); } };
  const remove = () => { try { deleteJavaTemplate(edit.prefix); setEdit({ prefix: "", detail: "", body: "", enabled: true }); setError(""); setFeedback("已删除自定义模板或恢复内置默认值"); } catch (reason) { setError(String(reason)); setFeedback(""); } };
  return <Modal open ariaLabel="Java 代码模板" onClose={onClose} className="mx-4 w-full max-w-3xl rounded-[var(--r-dialog)] modal-surface p-5">
    <h3 className="mb-2 text-base font-semibold">Java 代码模板</h3>
    <p className="mb-4 text-sm text-muted-foreground">输入前缀选择补全。$1、$2 为编辑位置，$0 为最终光标；修改内置模板可恢复默认。</p>
    <div className="grid grid-cols-[minmax(120px,1fr)_minmax(0,3fr)] gap-4">
      <div className="max-h-80 overflow-auto" aria-label="模板列表">{all.map(item => <button type="button" key={item.prefix} className="block w-full rounded-[var(--r-control)] px-2 py-1.5 text-left text-sm hover:bg-accent" aria-pressed={edit.prefix === item.prefix} onClick={() => { setEdit({ ...item }); setError(""); }}>{item.prefix}<span className="ml-2 text-xs text-muted-foreground">{item.enabled === false ? "已关闭" : item.detail}</span></button>)}</div>
      <div className="space-y-3">
        <label className="block text-sm">前缀<Input className="mt-1" value={edit.prefix} onChange={event => setEdit({ ...edit, prefix: event.target.value })} /></label>
        <label className="block text-sm">说明<Input className="mt-1" value={edit.detail} onChange={event => setEdit({ ...edit, detail: event.target.value })} /></label>
        <label className="block text-sm">代码<textarea spellCheck={false} className="nj-pv input-surface mt-1 h-40 w-full" value={edit.body} onChange={event => setEdit({ ...edit, body: event.target.value })} /></label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={edit.enabled !== false} onChange={event => setEdit({ ...edit, enabled: event.target.checked })} />启用模板</label>
      </div>
    </div>
    {error && <p className="mt-3 text-sm text-destructive-ink" role="alert">{error}</p>}
    {feedback && !error && <p className="mt-3 text-sm text-muted-foreground" role="status">{feedback}</p>}
    <div className="mt-4 flex justify-end gap-2"><Button variant="outline" size="sm" onClick={() => { setEdit({ prefix: "", detail: "", body: "", enabled: true }); setError(""); }}>新建</Button><Button variant="outline" size="sm" disabled={!custom.some(item => item.prefix === edit.prefix)} onClick={remove}>{BUILTIN_JAVA_TEMPLATES.some(item => item.prefix === edit.prefix) ? "恢复默认" : "删除"}</Button><Button variant="outline" size="sm" onClick={onClose}>关闭</Button><Button size="sm" onClick={save}>保存模板</Button></div>
  </Modal>;
}
