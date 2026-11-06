import type { QueryClient } from "@tanstack/react-query";
import { closeModel } from "./editorStore";
import { stopLang } from "./lang";
import { resetSearchForm } from "./searchStore";
import { resetSymbolCache } from "./symbols";
import { getSession, setSession } from "./workspaceSession";
import { setWorkspace } from "./workspace";
import { resetNav } from "./navHistory";
import { compileCancel } from "./compile";
import { rememberRoot } from "./recentRoots";
import { clearClosed } from "./closedTabs";
import { resetMru } from "./tabMru";
import { invalidateWorkspaceRequests } from "./workspaceEpoch";

/**
 * 切换工作区：改配置 + 清掉属于旧工作区的会话状态。
 *
 * 为什么抽出来：入口是文件页顶部的目录框（含最近工作区），「工程关联」弹框只在
 * 打开时跟着 root 重读、不自己切。各入口各写一套的话必然分叉：一边关了编辑器模型、
 * 一边忘了停 jdt.ls，就会出现「在新工作区里补全跳到旧工程」这种鬼故事。
 * **切换的副作用只在 lib 里定义一次。**
 *
 * 调用方负责的两件事（这里做不了/不该做）：
 * 1. **先处理未保存的修改**（`lib/saveAllDirty`）：这里会 `closeModel` 掉所有标签，
 *    没落盘的改动就此消失。
 * 2. 切换后刷新自己的数据（文件页改 `root`；工程关联弹框靠 root 变更重读）。
 */
export async function applyWorkspace(
  path: string,
  queryClient?: QueryClient,
): Promise<string> {
  // set_workspace 会让后端规范化路径，返回的才是真值；失败时抛错，下方副作用一概不做
  const shown = await setWorkspace(path);
  invalidateWorkspaceRequests();
  rememberRoot(shown);

  const { tabs } = getSession();
  tabs.forEach((t) => closeModel(t.path));
  // 停掉 jdt.ls：它按工作区建索引，工作区换了必须重建，留着只会指向旧工程
  void stopLang();
  setSession({ tabs: [], activePath: null, splitPath: null });
  // 会话里的 root 就是文件页的树根。不写它的话，工作区已经换了而文件页还挂着旧目录，
  // 点了树才报错说路径不在工作区里
  setSession({ root: shown });
  // 旧工程还在跑的编译立刻停掉：它会继续往刚被切走的目录里写 class，
  // 跑完还会把结果写进新工程的会话（`useModuleCompile` 也有兜底，但先停更省事）
  void compileCancel().catch(() => {});
  // 编译结果与日志都指向旧工程，留着会被误读成新工程的问题列表
  setSession({ compiling: false, compileResult: null, compileLog: [] });
  // 搜索页的结果/替换汇总都属于旧工作区：留着的话确认框拿旧工作区的改动面骗人，
  // 而替换实际打在新工作区（SearchTab 被保活不重挂载，本地 state 不会自己更新）
  resetSearchForm();
  // 三个「等用户决定」的挂起状态同样是旧工作区的：留着就是僵尸确认框
  // （关闭未保存文件 / 异地修改冲突 / 编码提示，对应的标签都已经没了）
  setSession({ closingPath: null, conflictPath: null, encodingIssue: null, problemsPath: null });
  // 符号缓存按路径存，不认工作区：旧工程的符号在新工程里只会误导面包屑与结构面板
  resetSymbolCache();
  // 导航历史里全是旧工作区的路径，留着「后退」只会被路径守卫挡住报错
  resetNav();
  // 重开栈 / MRU 同理：里面的路径在新工程里没有意义
  clearClosed();
  resetMru();
  // 文件树按 root 归属缓存，由 FileTree 自己重置（key={root}），这里不动

  void queryClient?.invalidateQueries({ queryKey: ["svn-info"] });
  void queryClient?.invalidateQueries({ queryKey: ["svn-status"] });
  return shown;
}
