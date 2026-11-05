import { Menu, MenuItem } from "../ui/Menu";
import { Button } from "../ui/button";
import { WorkspaceGlyph } from "./WorkspaceGlyph";
import { useOperations } from "../../lib/operations";
import { listTasks, runTask, STEP_SHORT } from "../../lib/ncTasks";

/**
 * 标签条上的「任务」下拉：内置的编译/投送/重启/补丁组合，加上本工作区自定义的任务。
 * 任务定义在设置 → 任务里维护；这里只负责运行，不提供任意命令输入。
 */
export function TaskMenu({ root, compiling }: { root: string; compiling: boolean }) {
  const tasks=useOperations();const running=tasks.some(o=>o.key==="nc.task" && !o.endedAt);
  return (
    <Menu
      portal
      width="w-72"
      trigger={(open, toggle) => (
        <Button
          size="sm"
          variant="outline"
          className="wb-task-btn"
          disabled={compiling || running || !root}
          aria-expanded={open}
          title="运行 NC 任务（编译 / 投送 / 重启 / 补丁）"
          onClick={toggle}
        >
          <WorkspaceGlyph name="play" size={12} />
          任务
          <WorkspaceGlyph name="down" size={12} />
        </Button>
      )}
    >
      {(close) =>
        listTasks(root).map((t) => (
          <MenuItem
            key={t.id}
            label={t.name}
            hint={t.steps.map((s) => STEP_SHORT[s]).join(" → ")}
            disabled={compiling || running}
            onClick={() => {
              close();
              void runTask(t);
            }}
          />
        ))
      }
    </Menu>
  );
}
