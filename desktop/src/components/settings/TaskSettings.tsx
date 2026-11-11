import { useState } from "react";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { SettingsRow } from "../ui/SettingsRow";
import { toast } from "../ui/toast";
import { useWorkspaceSelector } from "../../lib/workspaceSession";
import { addTask, updateTask, loadCustomTasks, removeTask, BUILTIN_TASKS, STEP_LABELS, type NcTask } from "../../lib/ncTasks";
import { TaskEditor, newTaskDraft, type TaskDraft } from "./TaskEditor";
import { SettingsPath } from "./SettingsPath";
import "./settings-development.css";

const stepsText = (task: NcTask) => task.steps.map(step => STEP_LABELS[step]).join(" → ");

export function TaskSettings() {
  const workspace = useWorkspaceSelector(s => s.root) ?? null;
  const key = workspace?.toLowerCase() ?? "";
  // Drafts belong to their workspace even while the settings page remains mounted.
  const [drafts, setDrafts] = useState<Record<string, TaskDraft>>({});
  const [action, setAction] = useState<{ task: NcTask; workspace: string; kind: "delete" | "edit" | "new" } | null>(null);
  const [feedback, setFeedback] = useState<string>();
  const [, refresh] = useState(0);
  const draft = drafts[key] ?? newTaskDraft();
  const tasks = loadCustomTasks(workspace);
  const change = (next: TaskDraft) => setDrafts(prev => ({ ...prev, [key]: next }));
  const start = (task?: NcTask) => change(task ? { id: task.id, name: task.name, steps: [...task.steps], open: true } : { ...newTaskDraft(), open: true });
  const select = (task?: NcTask) => {
    if (!workspace) return;
    // 守卫看草稿内容而非展开态：「收起并保留草稿」后新建/编辑同样要先确认，不能无声覆盖。
    if (draft.name.trim() || draft.id || draft.steps.join() !== newTaskDraft().steps.join()) setAction({ task: task ?? { id: "", name: "", steps: [] }, workspace, kind: task ? "edit" : "new" });
    else start(task);
  };
  const save = () => {
    const result = draft.id ? updateTask(workspace, draft.id, draft.name, draft.steps) : addTask(workspace, draft.name, draft.steps);
    if (!result.ok) { change({ ...draft, error: result.error }); return; }
    change(newTaskDraft());
    setFeedback(`已保存任务「${result.task.name}」。从工作台任务菜单运行。`);
    refresh(n => n + 1);
  };
  const confirmAction = () => {
    const pending = action;
    setAction(null);
    if (!pending) return;
    if (pending.workspace.toLowerCase() !== key) { setFeedback("工程已切换，请在原工作区完成操作。"); return; }
    if (pending.kind !== "delete") { start(pending.kind === "edit" ? pending.task : undefined); return; }
    if (!removeTask(pending.workspace, pending.task.id)) { toast("删除失败：本机存储不可用", "error"); return; }
    if (draft.id === pending.task.id) change(newTaskDraft());
    setFeedback(`已删除任务「${pending.task.name}」。`);
    refresh(n => n + 1);
  };
  return <div className="settings-task-page">
    <div className="settings-task-toolbar">
      <div><h2>当前工作区</h2><SettingsPath value={workspace} label="任务工作区路径" empty="尚未打开工程" /></div>
      <Button size="sm" disabled={!workspace} onClick={() => select()}>新建任务</Button>
    </div>
    {!workspace && <p className="settings-help">打开工程后可创建任务。<Button variant="link" size="sm" onClick={() => window.dispatchEvent(new CustomEvent("ncforge-navigate", { detail: "files" }))}>去打开工程</Button></p>}
    {feedback && <p role="status" className="settings-help">{feedback}</p>}
    <TaskEditor key={key} draft={draft} disabled={!workspace} onChange={change} onSave={save} />
    <h2>自定义任务 <span className="settings-help">（{tasks.length}/20）</span></h2>
    {!tasks.length && <p className="settings-help">还没有自定义任务。可将编译、投送元数据与重启组合成常用流程。</p>}
    {tasks.map(task => <SettingsRow key={task.id} id={`task-${task.id}`} label={task.name}
      sub={stepsText(task)} valueText="当前工作区"
      control={<div className="settings-form-actions">
        <Button variant="outline" size="sm" aria-label={`编辑任务「${task.name}」`} onClick={() => select(task)}>编辑</Button>
        <Button variant="ghost" size="sm" aria-label={`删除任务「${task.name}」`} onClick={() => { if (workspace) setAction({ task, workspace, kind: "delete" }); }}>删除</Button>
      </div>} />)}
    <details className="settings-task-builtins"><summary>内置任务 <span>{BUILTIN_TASKS.length} 个固定流程 · 只读</span></summary>
      <p className="settings-help">从工作台任务菜单运行。编译失败时不会继续投送或重启。</p>
      {BUILTIN_TASKS.map(task => <SettingsRow key={task.id} id={`task-${task.id}`} label={task.name} sub={stepsText(task)} valueText="内置 · 只读" />)}
    </details>
    <ConfirmDialog open={action !== null} variant={action?.kind === "delete" ? "destructive" : "default"}
      title={action?.kind === "delete" ? "删除自定义任务？" : "放弃当前任务草稿？"}
      description={action?.kind === "delete" ? `将删除「${action.task.name}」。` : "切换编辑任务会替换当前草稿；收起表单可以保留草稿。"}
      confirmLabel={action?.kind === "delete" ? "删除" : "放弃并继续"} onCancel={() => setAction(null)} onConfirm={confirmAction} />
  </div>;
}
