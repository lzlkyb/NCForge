import { useEffect, useRef } from "react";
import { registerCommands } from "../lib/commandRegistry";
import { EDITOR_COMMANDS, currentIsJava, runEditorCommand } from "../lib/editorActions";
import { compileCancel } from "../lib/compile";
import { toast } from "../components/ui/toast";
import { langRegenerate } from "../lib/appConfig";

/** 命令面板里文件页命令用到的「当前值」。闭包每次渲染都是新的，所以经 ref 读最新值。 */
export interface FilesTabCommands {
  activePath: string | null;
  compiling: boolean;
  compileActive: () => void;
  closeTab: (path: string) => void;
  openOutline: () => void;
  openHistory: () => void;
  jumpToProblem: (dir: 1 | -1) => void;
  goBack: () => void;
  goForward: () => void;
  openRename: () => void;
  canBack: () => boolean;
  canForward: () => boolean;
  hasProblems: () => boolean;
}

/**
 * 把文件页的命令登记进命令面板（只登记一次，动作经 ref 读最新闭包）。
 *
 * 从 `FilesTab` 抽出来：命令清单本身有 60 行，混在接线组件里会把行数顶爆。
 * 注意「闭包过期」这个坑——`registerCommands` 只在挂载时跑一次，直接把渲染作用域的
 * 变量写进 run/enabled 会让它们永远是第一帧的值。所以调用方每帧传新对象，
 * 这里每帧覆写 ref，命令执行时从 `live.current` 读。
 */
export function useFilesTabCommands(deps: FilesTabCommands) {
  const live = useRef(deps);
  live.current = deps;

  useEffect(() => registerCommands([
    { id: "build.compile", title: "编译当前模块", run: () => void live.current.compileActive(), enabled: () => !!live.current.activePath && !live.current.compiling },
    { id: "build.cancel", title: "取消编译", run: () => void compileCancel(), enabled: () => live.current.compiling },
    { id: "tab.close", title: "关闭当前标签", run: () => live.current.activePath && live.current.closeTab(live.current.activePath), enabled: () => !!live.current.activePath },
    {
      id: "editor.outline",
      title: "文件结构（本文件的类 / 方法 / 字段列表）",
      run: () => live.current.openOutline(),
      enabled: () => !!live.current.activePath,
    },
    {
      id: "editor.history",
      title: "本地历史（本文件的历史版本，可恢复）",
      run: () => live.current.openHistory(),
      enabled: () => !!live.current.activePath,
    },
    {
      id: "editor.rename",
      title: "重命名符号（跨文件，F2）",
      run: () => live.current.openRename(),
      enabled: () => !!live.current.activePath && currentIsJava(),
    },
    {
      id: "nav.back",
      title: "后退（回到上一个跳转位置）",
      run: () => live.current.goBack(),
      enabled: () => live.current.canBack(),
    },
    {
      id: "nav.forward",
      title: "前进（回到后退之前的位置）",
      run: () => live.current.goForward(),
      enabled: () => live.current.canForward(),
    },
    {
      id: "problems.next",
      title: "跳到下一处问题",
      run: () => live.current.jumpToProblem(1),
      enabled: () => live.current.hasProblems(),
    },
    {
      id: "problems.prev",
      title: "跳到上一处问题",
      run: () => live.current.jumpToProblem(-1),
      enabled: () => live.current.hasProblems(),
    },
    {
      id: "lang.regenerate",
      title: "重新生成代码智能工程（补全 / 跳转异常时用）",
      run: () => void langRegenerate().then(() => toast("已重新生成并重启代码智能", "success"), (e) => toast(`重新生成失败：${e}`, "error")),
    },
    // 编辑器动作也进命令面板：找引用 / 格式化 / 快速修复这些操作不该逼用户记快捷键，
    // 敲「引用」「格式化」「父类」就能找到。java 之外的文件不列出来（列了点了也没反应）
    ...EDITOR_COMMANDS.map((c) => ({
      id: c.id,
      title: c.title,
      run: () => {
        if (!runEditorCommand(c.action)) toast("先把光标放到编辑器里再执行", "info");
      },
      enabled: () => !c.javaOnly || currentIsJava(),
    })),
  ]), []);
}
