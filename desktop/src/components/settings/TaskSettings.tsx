// 设置 → 任务：内置的运行配置只读，自定义任务按工作区保存在本机。
//
// 只允许固定步骤（编译 / 投送 / 重启 / 补丁），不提供任意命令输入：
// 这些步骤都会碰 NC 安装目录或起 JVM，自由命令等于把安全边界交给一个输入框。
import { useEffect, useRef, useState } from "react";
import { Card } from "../ui/card";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow } from "../ui/SettingsRow";
import { ToggleRow } from "../ui/ToggleRow";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { toast } from "../ui/toast";
import { useWorkspaceSelector } from "../../lib/workspaceSession";
import { useAutoCompilePref } from "../../hooks/useAutoCompilePref";
import {
  addTask,
  BUILTIN_TASKS,
  loadCustomTasks,
  removeTask,
  STEP_LABELS,
  type NcTask,
  type TaskStep,
} from "../../lib/ncTasks";
import { BuildSettings } from "./BuildSettings";
import "./settings-development.css";

const ALL_STEPS = Object.keys(STEP_LABELS) as TaskStep[];

const stepsText = (t: NcTask) => t.steps.map((s) => STEP_LABELS[s]).join(" → ");

export function TaskSettings() {
  const root = useWorkspaceSelector((s) => s.root) ?? null;
  const [custom, setCustom] = useState<NcTask[]>(() => loadCustomTasks(root));
  const [name, setName] = useState("");
  // 默认就是最常见的「编全部 → 投送」；勾选顺序即执行顺序
  const [steps, setSteps] = useState<TaskStep[]>(["compileAll", "deploy"]);
  const createRef = useRef<HTMLDetailsElement>(null);
  // 「保存时自动编译」的读取 / 写回 / 失败回滚都在这个 hook 里（读写约定见文件头注释）
  const auto = useAutoCompilePref();
  const [removeTarget, setRemoveTarget] = useState<NcTask | null>(null);

  useEffect(() => {
    setCustom(loadCustomTasks(root));
  }, [root]);

  const toggle = (s: TaskStep) =>
    setSteps((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  const add = () => {
    const r = addTask(root, name, steps);
    if (!r.ok) {
      toast(r.error, "warning");
      return;
    }
    setName("");
    setCustom(loadCustomTasks(root));
    if (createRef.current) createRef.current.open = false;
    toast(`已添加任务「${r.task.name}」`, "success");
  };

  // 删除是不可逆操作：先弹 destructive 确认框，别一点就删掉。
  const remove = (t: NcTask) => setRemoveTarget(t);
  const confirmRemove = () => {
    const t = removeTarget;
    setRemoveTarget(null);
    if (!t) return;
    if (!removeTask(root, t.id)) {
      toast("删除失败：本机存储不可用", "error");
      return;
    }
    setCustom(loadCustomTasks(root));
    toast(`已删除任务「${t.name}」`, "success");
  };

  return (
    <Card className="flex flex-col gap-1 p-2">
      <ToggleRow
        id="task-auto-compile"
        label="保存时自动编译"
        keywords={["编译", "保存", "auto compile", "自动"]}
        sub="只编刚保存的这一个文件，约 1~3 秒；产物写到模块的 classes"
        info="Eclipse 里保存即出 class，靠的是常驻进程 + 整工程依赖图，我们拿不到那份能力（实测 jdt.ls 每次启动要重建工作区，整工程 152 秒）。所以这里只编保存的那一个文件，够挡语法、拼写、import 这类错误。改了方法签名或继承关系时它发现不了引用方——那种改动请手动「编译模块」。"
        checked={auto.value ?? true}
        disabled={auto.value === null}
        valueText={auto.value === null ? "读取中" : auto.value ? "已开启" : "已关闭"}
        onChange={(v) => void auto.save(v)}
      />
      {auto.error && <p role="alert" className="flex items-center gap-2 px-2 py-1 text-xs text-destructive-ink">
        <span className="min-w-0 flex-1">{auto.error}</span>
        <Button size="sm" variant="ghost" onClick={auto.retry}>重试</Button>
      </p>}
      <BuildSettings />
      <details className="settings-task-builtins">
        <summary>内置任务 <span>{BUILTIN_TASKS.length} 个固定流程 · 只读</span></summary>
        <div>
      <SettingsRow
        id="task-builtin"
        label="运行方式"
        keywords={["内置任务"]}
        sub="固定步骤，只读；从工作台的任务菜单运行"
        valueText={`${BUILTIN_TASKS.length} 个内置任务`}
        info="任务在标签条右侧的「任务」下拉里运行。「编译当前模块」需要先打开一个文件；编译未通过时后面的投送 / 重启会自动跳过，避免把旧产物推上去。"
      />
      {BUILTIN_TASKS.map((t) => (
        <SettingsRow key={t.id} id={`task-${t.id}`} label={t.name} sub={stepsText(t)}
          valueText="内置 · 只读" />
      ))}
        </div>
      </details>

      <SettingsRow
        id="task-custom"
        label="自定义任务"
        sub={root ? "按当前工作区保存在本机，不上传" : "打开工程后可按工作区保存"}
        info="勾选顺序即执行顺序；某一步没做成（编译有错、投送失败、重启被挡）会停在那里并跳过后续步骤。"
        last={custom.length === 0}
        valueText={`${custom.length} 个自定义任务`}
      />
      {custom.map((t) => (
        <SettingsRow
          key={t.id}
          id={`task-${t.id}`}
          label={t.name}
          sub={stepsText(t)}
          valueText="当前工作区"
          control={
            <Button size="sm" variant="ghost" aria-label={`删除任务「${t.name}」`} onClick={() => remove(t)}>
              删除
            </Button>
          }
        />
      ))}
      {custom.length === 0 && <p className="text-xs text-muted-foreground pb-3">
        {root ? "还没有自定义任务，可将常用步骤组合成一个任务。" : "打开工程后，可保存此工作区的任务组合。"}
      </p>}

      <details ref={createRef} className="settings-task-create" id="task-new" tabIndex={-1}
        data-settings-item data-settings-label="新建任务"
        data-settings-description="按勾选顺序组合编译、投送、重启或补丁步骤"
        data-setting-value={root ? "按需创建" : "需先打开工程"}>
        <summary>新建任务</summary>
        <form className="settings-task-form" onSubmit={(e) => { e.preventDefault(); if (root && name.trim() && steps.length) add(); }}>
          <label className="settings-task-name" htmlFor="task-name-input">
            任务名称
            <Input id="task-name-input" value={name} maxLength={40} disabled={!root}
              placeholder="例如：编译全部并投送"
              onChange={(e) => setName(e.target.value)} />
          </label>
          <fieldset className="settings-task-steps" disabled={!root}>
            <legend>选择步骤（按勾选顺序执行）</legend>
            {ALL_STEPS.map((s) => (
              <label key={s}>
                <input type="checkbox" checked={steps.includes(s)} onChange={() => toggle(s)} />
                {STEP_LABELS[s]}
              </label>
            ))}
          </fieldset>
          <p className="settings-task-sequence" aria-live="polite">
            {steps.length ? `执行顺序：${steps.map((s) => STEP_LABELS[s]).join(" → ")}` : "至少选择一个步骤。"}
          </p>
          {!root && <p className="text-xs text-muted-foreground">请先打开工程，再创建此工作区的任务。</p>}
          <div className="settings-task-form-actions">
            <Button type="button" size="sm" variant="ghost" onClick={() => { if (createRef.current) createRef.current.open = false; }}>收起</Button>
            <Button type="submit" size="sm" disabled={!root || !name.trim() || steps.length === 0}>添加任务</Button>
          </div>
        </form>
      </details>

      <ConfirmDialog
        open={removeTarget !== null}
        variant="destructive"
        title="删除自定义任务？"
        description={removeTarget ? `将删除任务「${removeTarget.name}」，此操作不可撤销。` : undefined}
        confirmLabel="删除"
        onCancel={() => setRemoveTarget(null)}
        onConfirm={confirmRemove}
      />
    </Card>
  );
}
