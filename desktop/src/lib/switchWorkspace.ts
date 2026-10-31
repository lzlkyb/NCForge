import type { QueryClient } from "@tanstack/react-query";
import { closeModel } from "./editorStore";
import { stopLang } from "./lang";
import { getSession, setSession } from "./workspaceSession";
import { setWorkspace } from "./workspace";

/**
 * 切换工作区：改配置 + 清掉属于旧工作区的会话状态。
 *
 * 为什么抽出来：入口现在有两个——文件页顶部的目录框，和「工程关联」页的切换表单。
 * 两处各写一套的话必然分叉：一边关了编辑器模型、一边忘了停 jdt.ls，就会出现
 * 「在新工作区里补全跳到旧工程」这种鬼故事。**切换的副作用只在 lib 里定义一次。**
 *
 * 调用方负责的两件事（这里做不了/不该做）：
 * 1. **先处理未保存的修改**（`lib/saveAllDirty`）：这里会 `closeModel` 掉所有标签，
 *    没落盘的改动就此消失。
 * 2. 切换后刷新自己的数据（文件页改 `root`、工程关联页重读依赖链）。
 */
export async function applyWorkspace(
  path: string,
  queryClient?: QueryClient,
): Promise<string> {
  // set_workspace 会让后端规范化路径，返回的才是真值；失败时抛错，下方副作用一概不做
  const shown = await setWorkspace(path);

  const { tabs } = getSession();
  tabs.forEach((t) => closeModel(t.path));
  // 停掉 jdt.ls：它按工作区建索引，工作区换了必须重建，留着只会指向旧工程
  void stopLang();
  setSession({ tabs: [], activePath: null });
  // 会话里的 root 就是文件页的树根。不写它的话，从「工程关联」页切完工作区，
  // 文件页（此时是隐藏的，不会自己重读）回来还挂着旧目录——点了树才报错说路径不在工作区里
  setSession({ root: shown });
  // 编译结果与日志都指向旧工程，留着会被误读成新工程的问题列表
  setSession({ compileResult: null, compileLog: [] });
  // 文件树按 root 归属缓存，由 FileTree 自己重置（key={root}），这里不动

  void queryClient?.invalidateQueries({ queryKey: ["svn-info"] });
  void queryClient?.invalidateQueries({ queryKey: ["svn-status"] });
  return shown;
}
