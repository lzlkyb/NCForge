import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { STEP_LABELS, type TaskStep } from "../../lib/ncTasks";

export interface TaskDraft { id?: string; name: string; steps: TaskStep[]; open: boolean; error?: string }
export const newTaskDraft = (): TaskDraft => ({ name: "", steps: ["compileAll", "deploy"], open: false });

export function TaskEditor({ draft, disabled, onChange, onSave }: {
  draft: TaskDraft; disabled: boolean; onChange: (next: TaskDraft) => void; onSave: () => void;
}) {
  const update = (patch: Partial<TaskDraft>) => onChange({ ...draft, error: undefined, ...patch });
  const move = (index: number, delta: number) => {
    const steps = [...draft.steps];
    [steps[index], steps[index + delta]] = [steps[index + delta], steps[index]];
    update({ steps });
  };
  return <details className="settings-task-create" id="task-new" tabIndex={-1} open={draft.open}
    onToggle={e => { if (draft.open !== e.currentTarget.open) update({ open: e.currentTarget.open }); }}
    data-settings-item data-settings-label="新建或编辑任务" data-settings-description="按编号组合编译、投送元数据、重启或打开补丁打包"
    data-setting-value={disabled ? "需先打开工程" : draft.id ? "编辑任务" : "新建任务"}>
    <summary>{draft.id ? `编辑任务：${draft.name}` : "新建任务"}</summary>
    <form className="settings-task-form" onSubmit={e => { e.preventDefault(); if (!disabled) onSave(); }}>
      <label className="settings-task-name" htmlFor="task-name-input">任务名称
        <Input id="task-name-input" value={draft.name} maxLength={40} disabled={disabled}
          placeholder="例如：编译并投送" onChange={e => update({ name: e.target.value })} />
      </label>
      <fieldset className="settings-task-steps" disabled={disabled}>
        <legend>执行步骤（按编号顺序执行）</legend>
        <ol className="settings-task-ordered">
          {draft.steps.map((step, index) => <li key={step}>
            <span className="settings-step-number">{index + 1}</span><span className="settings-step-label">{STEP_LABELS[step]}</span>
            <div className="settings-step-actions">
              <Button type="button" variant="ghost" size="sm" disabled={disabled || index === 0} aria-label={`上移${STEP_LABELS[step]}`} onClick={() => move(index, -1)}>上移</Button>
              <Button type="button" variant="ghost" size="sm" disabled={disabled || index === draft.steps.length - 1} aria-label={`下移${STEP_LABELS[step]}`} onClick={() => move(index, 1)}>下移</Button>
              <Button type="button" variant="ghost" size="sm" aria-label={`移除${STEP_LABELS[step]}`} onClick={() => update({ steps: draft.steps.filter(s => s !== step) })}>移除</Button>
            </div>
          </li>)}
        </ol>
        <label className="settings-task-add">添加步骤
          <select className="settings-select" aria-label="添加执行步骤" value="" onChange={e => { if (e.target.value) update({ steps: [...draft.steps, e.target.value as TaskStep] }); }}>
            <option value="">选择要添加的步骤…</option>
            {(Object.keys(STEP_LABELS) as TaskStep[]).filter(step => !draft.steps.includes(step)).map(step => <option key={step} value={step}>{STEP_LABELS[step]}</option>)}
          </select>
        </label>
      </fieldset>
      <p className="settings-task-sequence" aria-live="polite">{draft.steps.length ? draft.steps.map(step => STEP_LABELS[step]).join(" → ") : "请至少添加一个步骤。"}</p>
      <p className="settings-help">某一步失败后停止流程，跳过后续步骤。保存不会运行任务。</p>
      {disabled && <p className="settings-help">请先打开工程，再创建此工作区的任务。</p>}
      {draft.error && <p className="settings-inline-error" role="alert">{draft.error}</p>}
      <div className="settings-form-actions">
        <Button type="button" size="sm" variant="ghost" onClick={() => update({ open: false })}>收起并保留草稿</Button>
        <Button type="submit" size="sm" disabled={disabled || !draft.name.trim() || !draft.steps.length}>{draft.id ? "保存任务" : "添加任务"}</Button>
      </div>
    </form>
  </details>;
}
