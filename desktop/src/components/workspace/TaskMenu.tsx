import { Menu, MenuItem } from "../ui/Menu";
import { Button } from "../ui/button";
import { WorkspaceGlyph } from "./WorkspaceGlyph";
import { Icon } from "../ui/icon";
import { useOperations } from "../../lib/operations";
import { listTasks, runTask, STEP_SHORT } from "../../lib/ncTasks";

/**
 * 标签条上的「任务」下拉：内置的编译/投送/重启/补丁组合，加上本工作区自定义的任务。
 * 任务定义在设置 → 任务里维护；这里只负责运行，不提供任意命令输入。
 */
export function TaskMenu({ root, compiling, compile }: { root: string; compiling: boolean; compile?: { module: string | null; reason: string | null; run: () => void } }) {
  const tasks=useOperations();const running=tasks.some(o=>o.key==="nc.task" && !o.endedAt);
  const menu = (
    <Menu
      portal
      width="w-72"
      trigger={(open, toggle) => (
        compile ? <button type="button" className="wb-compile-dropdown" disabled={compiling || running || !root}
            aria-label="运行 NC 任务" title="其他开发任务" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
            <WorkspaceGlyph name="down" size={12} />
          </button> : <Button
          size="sm"
          variant="outline"
          className="wb-task-btn"
          disabled={compiling || running || !root}
          aria-label="运行 NC 任务"
          aria-haspopup="menu"
          aria-expanded={open}
          title="运行 NC 任务（编译 / 投送 / 重启 / 补丁）"
          onClick={toggle}
        >
          <Icon name="terminal" size={16} />
          <span className="wb-task-label">开发任务</span>
          <WorkspaceGlyph name="down" size={12} className="wb-task-chevron" />
        </Button>
      )}
    >
      {(close) => <>
        {compile && <p className="wb-menu-caption">当前模块：{compile.module ?? "未选择"}</p>}
        {listTasks(root).map((t) => (
          <MenuItem
            key={t.id}
            label={t.name}
            hint={t.steps.map((s) => STEP_SHORT[s]).join(" → ")}
            disabled={compiling || running || t.id === "builtin.compileActive" && !!compile?.reason}
            onClick={() => {
              close();
              if (compile && t.id === "builtin.compileActive") compile.run();
              else void runTask(t);
            }}
          />
        ))}
      </>}
    </Menu>
  );
  return compile ? <div className="wb-compile-split">
    <button type="button" className="wb-compile-primary" disabled={compiling || running || !!compile.reason}
      title={compile.reason ?? `编译 ${compile.module} 模块，未保存修改会先提示确认`} onClick={compile.run}>
      <Icon name={compiling ? "spinner" : "hammer"} size={14} className={compiling ? "animate-spin" : undefined} />
      <span>{compiling ? "编译中…" : compile.module ? `编译 ${compile.module} 模块` : "编译当前模块"}</span>
    </button>{menu}
  </div> : menu;
}
