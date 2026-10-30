/**
 * 命令面板的命令登记处。
 *
 * 命令的执行者分散在不同组件里（编译在文件页、切侧栏在布局仓库、导航在 App），面板不该认识它们。
 * 各自挂载时登记、卸载时注销；面板打开时读当前清单。
 */
export interface Command {
  id: string;
  title: string;
  /** 右侧的快捷键提示。 */
  hint?: string;
  run: () => void;
  /** 返回 false 时不在列表里出现（如「取消编译」只在编译中有意义）。 */
  enabled?: () => boolean;
}

const registry = new Map<string, Command>();

/** 登记一组命令，返回注销函数。同 id 后来者覆盖前者。 */
export function registerCommands(cmds: Command[]): () => void {
  cmds.forEach((c) => registry.set(c.id, c));
  return () => {
    // 只注销自己登记的那一份：后来者已经覆盖了同 id 时不能把人家的一起删掉
    cmds.forEach((c) => {
      if (registry.get(c.id) === c) registry.delete(c.id);
    });
  };
}

export function listCommands(): Command[] {
  return [...registry.values()].filter((c) => !c.enabled || c.enabled());
}
