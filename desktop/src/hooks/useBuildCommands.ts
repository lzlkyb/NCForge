import { useEffect, useRef } from "react";
import { registerCommands } from "../lib/commandRegistry";
import { getSession } from "../lib/workspaceSession";
import { isJavaFile } from "../lib/autoCompile";
import { dirName } from "../lib/workspace";
import { moduleOf } from "../lib/ncModule";
import { askCleanTmp } from "../lib/buildMaintenance";
import type { BuildMaintenance } from "./useBuildMaintenance";

/**
 * 命令面板里的构建维护命令（清理 / 清理并重编 / 重建索引 / 清理临时文件）。
 *
 * 与「编译」命令分开：这些操作都要先确认，动作入口是 `BuildMaintenance`；
 * 「清理编译临时文件」走 buildMaintenance 的 `askCleanTmp`（先 dry-run 统计、再二次确认、
 * 后带进度执行并防连点），不再一条命令直接删。闭包经 ref 取最新，`registerCommands` 只跑一次。
 */
export function useBuildCommands(build: BuildMaintenance) {
  const live = useRef(build);
  live.current = build;

  useEffect(
    () =>
      registerCommands([
        {
          id: "build.rebuildModule",
          title: "清理并重编当前模块（删产物后全量编）",
          run: () => {
            const target = activeModule();
            if (target) void live.current.askRebuild(target.path, target.module);
          },
          enabled: () => !!activeModule() && !getSession().compiling,
        },
        {
          id: "build.cleanModule",
          title: "清理当前模块的编译产物",
          run: () => {
            const target = activeModule();
            if (target) void live.current.askClean(target.path, target.module);
          },
          enabled: () => !!activeModule() && !getSession().compiling,
        },
        {
          id: "build.rebuildAll",
          title: "清理并重编全部模块",
          run: () => void live.current.askRebuild(),
          enabled: () => !!getSession().root && !getSession().compiling,
        },
        {
          id: "build.cleanAll",
          title: "清理全部模块的编译产物",
          run: () => void live.current.askClean(),
          enabled: () => !!getSession().root && !getSession().compiling,
        },
        {
          id: "build.reindex",
          title: "重建类索引（下次编译重新扫描 jar）",
          run: () => live.current.askReindex(),
          enabled: () => !!getSession().root && !getSession().compiling,
        },
        {
          id: "build.cleanTmp",
          title: "清理编译临时文件",
          run: () => void askCleanTmp(),
        },
      ]),
    [],
  );
}

/** 当前活动文件所属模块（虚拟标签 / 非 java 返回 null）。 */
function activeModule(): { path: string; module: string } | null {
  const s = getSession();
  const path = s.activePath;
  if (!path || path.includes("://") || !isJavaFile(path)) return null;
  const module = moduleOf(s.root ?? "", dirName(path));
  return module ? { path, module } : null;
}
