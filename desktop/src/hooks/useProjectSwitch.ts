import { useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { beginOperation, operationActive } from "../lib/operations";
import { toast } from "../components/ui/toast";
import { applyWorkspace } from "../lib/switchWorkspace";
import { requestOpenFile } from "../lib/openFileRequest";
import { getDirectSwitch } from "../lib/projectSwitchPref";
import { isUnderPath, projectForPath } from "../lib/treeProjects";
import { ensureFilesSaved } from "../lib/terminatePreflight";
import type { LinkedProject } from "../lib/linkedProjects";

export interface SwitchTarget {
  project: LinkedProject;
  path: string;
  line?: number;
  column?: number;
}

/**
 * 跨工程打开文件 / 切换工作区。
 *
 * 从 `FilesTab` 抽出来（组件体量门禁），但边界本身也是对的：这一整块只有三个入口
 * （文件树、搜索命中、最近工作区），而「保存 → 切工作区 → 打开」必须是同一个实现——
 * 分成两份必然出现「从搜索点进去忘了保存」这类分叉。
 *
 * 切换会关掉全部标签并重建 jdt.ls 索引，所以默认先确认；确认框里勾过「直接切换」
 * 之后才跳过（偏好同时暴露在文件树标题栏）。
 */
export function useProjectSwitch({
  root,
  projects,
  queryClient,
  setRoot,
  openFile,
}: {
  root: string | null;
  projects: LinkedProject[];
  queryClient: QueryClient;
  setRoot: (root: string) => void;
  openFile: (path: string, opts?: { preview?: boolean }) => Promise<boolean>;
}) {
  const [switchTarget, setSwitchTarget] = useState<SwitchTarget | null>(null);

  /**
   * 切工作区的唯一实现。返回值区分「成功」「用户取消保存」「失败」：
   * `applyRoot` 对外只回报错误文案，跨工程打开则必须知道保存确认被取消——
   * 否则会把取消当成成功，接着去打开一个属于旧工作区白名单外的路径。
   */
  const switchWorkspace = async (path: string): Promise<{ ok: boolean; message?: string }> => {
    const task=beginOperation({key:"workspace.switch",label:"切换工程",scope:path,page:"files",phase:"检查未保存文件"});
    if(!task) return {ok:false,message:"正在切换工程，请等待当前操作结束"};
    try {
      if (!(await ensureFilesSaved("切换工程"))) {task.finish("cancelled","已取消切换，当前工程未变");return {ok:false};}
      task.update({phase:"验证目录并切换工作区"});
      // 切换的副作用（关模型 / 停 jdt.ls / 清会话 / 失效 svn 缓存）统一在 lib 里，
      // 各入口各写一套必然分叉
      const shown = await applyWorkspace(path, queryClient);
      setRoot(shown);
      task.finish("success","工程已切换；代码智能按新工程单独准备");
      return { ok: true };
    } catch (e) {
      const message = `无法打开目录：${e}`;
      // 返回值给引导页留在输入框下方，toast 给树头 / 最近工作区这些没有行内位置的入口
      task.finish("failed",message);
      toast(message, "error");
      return { ok: false, message };
    }
  };

  const applyRoot = async (path: string): Promise<string | null> => {
    const r = await switchWorkspace(path);
    return r.message ?? null;
  };

  const switchAndOpen = async (target: SwitchTarget) => {
    if(operationActive("workspace.switch")) return;
    setSwitchTarget(null);
    if (!target.project.root) return;
    const r = await switchWorkspace(target.project.root);
    if (!r.ok) return;
    // 用请求通道而不是直接调 openFile：切换后本组件的回调闭包还拿着旧会话，
    // 请求通道会在新会话里消费这条打开请求（行号 / 列号也一起带上）。
    requestOpenFile({ path: target.path, line: target.line, column: target.column });
  };

  /**
   * 在任意关联工程里打开文件。
   *
   * 当前工程内的路径直接走原有管道；别的工程先切工作区再打开（切换会清掉标签，
   * 所以必须等它完成）。默认弹确认框：关掉全部标签与重建索引的代价不该被隐藏。
   */
  const openPath = (path: string, pos?: { line?: number; column?: number }) => {
    if (!root) return;
    if (isUnderPath(path, root)) {
      if (pos?.line != null) requestOpenFile({ path, ...pos });
      else void openFile(path, { preview: true });
      return;
    }
    const project = projectForPath(path, projects);
    if (!project?.root) {
      toast("这个文件不在任何关联工程里", "warning");
      return;
    }
    if (getDirectSwitch()) {
      void switchAndOpen({ project, path, ...pos });
      return;
    }
    setSwitchTarget({ project, path, ...pos });
  };

  return { switchTarget, setSwitchTarget, applyRoot, openPath, switchAndOpen };
}
