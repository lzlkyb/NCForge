// 设置 → 任务：内置的运行配置只读，自定义任务按工作区保存在本机。
//
// 只允许固定步骤（编译 / 投送 / 重启 / 补丁），不提供任意命令输入：
// 这些步骤都会碰 NC 安装目录或起 JVM，自由命令等于把安全边界交给一个输入框。
import { useEffect, useState } from "react";
import { Card } from "../ui/card";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow } from "../ui/SettingsRow";
import { toast } from "../ui/toast";
import { useWorkspaceSelector } from "../../lib/workspaceSession";
import {
  addTask,
  BUILTIN_TASKS,
  loadCustomTasks,
  removeTask,
  STEP_LABELS,
  type NcTask,
  type TaskStep,
} from "../../lib/ncTasks";

const ALL_STEPS = Object.keys(STEP_LABELS) as TaskStep[];

const stepsText = (t: NcTask) => t.steps.map((s) => STEP_LABELS[s]).join(" → ");

export function TaskSettings() {
  const root = useWorkspaceSelector((s) => s.root) ?? null;
  const [custom, setCustom] = useState<NcTask[]>(() => loadCustomTasks(root));
  const [name, setName] = useState("");
  // 默认就是最常见的「编全部 → 投送」；勾选顺序即执行顺序
  const [steps, setSteps] = useState<TaskStep[]>(["compileAll", "deploy"]);

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
    toast(`已添加任务「${r.task.name}」`, "success");
  };

  const remove = (t: NcTask) => {
    if (!removeTask(root, t.id)) {
      toast("删除失败：本机存储不可用", "error");
      return;
    }
    setCustom(loadCustomTasks(root));
    toast(`已删除任务「${t.name}」`, "success");
  };

  return (
    <Card className="flex flex-col gap-1 p-2">
      <SettingsRow
        label="内置任务"
        sub="只读：由编译 / 投送 / 重启 / 补丁的固定步骤组成"
        info="任务在标签条右侧的「任务」下拉里运行。「编译当前模块」需要先打开一个文件；编译未通过时后面的投送 / 重启会自动跳过，避免把旧产物推上去。"
      />
      {BUILTIN_TASKS.map((t) => (
        <SettingsRow key={t.id} label={t.name} sub={stepsText(t)} />
      ))}

      <SettingsRow
        label="自定义任务"
        sub={root ? "按当前工作区保存在本机，不上传" : "打开工程后可按工作区保存"}
        info="勾选顺序即执行顺序；某一步没做成（编译有错、投送失败、重启被挡）会停在那里并跳过后续步骤。"
        last={custom.length === 0}
      />
      {custom.map((t) => (
        <SettingsRow
          key={t.id}
          label={t.name}
          sub={stepsText(t)}
          control={
            <Button size="sm" variant="ghost" onClick={() => remove(t)}>
              删除
            </Button>
          }
        />
      ))}

      <SettingsRow
        layout="stack"
        label="新建任务"
        last
        sub={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {ALL_STEPS.map((s) => (
              <label key={s} className="flex items-center gap-1 text-sm">
                <input type="checkbox" checked={steps.includes(s)} onChange={() => toggle(s)} />
                {STEP_LABELS[s]}
              </label>
            ))}
          </span>
        }
        control={
          <span className="flex items-center gap-2">
            <Input
              className="w-56"
              value={name}
              maxLength={40}
              placeholder="任务名（如：编全部并投送）"
              onChange={(e) => setName(e.target.value)}
            />
            <Button size="sm" disabled={!root || !name.trim() || steps.length === 0} onClick={add}>
              添加
            </Button>
          </span>
        }
      />
    </Card>
  );
}
