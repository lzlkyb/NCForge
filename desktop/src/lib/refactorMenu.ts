// 「重构」单一入口。
//
// 在此之前，重构能力散在 14 个地方：4 个提取（Ctrl+Alt+M/V/F/C）、1 个提取参数
// （Ctrl+Alt+P）、8 个 workbench 命令（只在命令面板能搜到）、组织导入（Ctrl+Alt+O）。
// 除了提取那 4 个，其余全部「存在但用户不知道」——方案里记的是 G4。
//
// 这个菜单不实现任何重构，只做「发现 + 分发」：命令仍然各自独立可调，菜单项按
// 使用场景分组，每项给一句话说明。键位与 Eclipse 的 Refactor 菜单对齐（Alt+Shift+T），
// 迁过来的用户不用重新记。
import { useSyncExternalStore } from "react";
import { registerCommands } from "./commandRegistry";
import { currentSelection } from "./editorActions";
import { pathOfModel } from "./editorStore";
import { langReady } from "./lang";
import { toast } from "../components/ui/toast";
import { runRefactor } from "./refactor";
import { runExtractParameter } from "./refactorParameter";
import { REFACTOR_KINDS } from "./refactorPlan";
import {
  openRefactorWorkbench,
  REFACTOR_LABELS,
  type WorkbenchRefactor,
} from "./refactorWorkbench";

export type RefactorMenuGroup = "提取" | "内联" | "移动与重命名" | "批量与搜索";

export interface RefactorMenuItem {
  id: string;
  label: string;
  hint: string;
  group: RefactorMenuGroup;
  run: () => void | Promise<void>;
}

const EXTRACT_KEYS: Record<string, string> = {
  extractMethod: "Ctrl+Alt+M",
  extractVariable: "Ctrl+Alt+V",
  extractField: "Ctrl+Alt+F",
  extractConstant: "Ctrl+Alt+C",
};

/** 菜单清单。每次打开现算：这些动作只读当前编辑器状态，不需要缓存。 */
export function refactorMenuItems(): RefactorMenuItem[] {
  const items: RefactorMenuItem[] = [];
  for (const [kind, spec] of Object.entries(REFACTOR_KINDS)) {
    items.push({
      id: `refactor.workbench.extract.${kind}`,
      label: spec.label,
      hint: `先选中${spec.need} · ${EXTRACT_KEYS[kind] ?? ""}`.trim(),
      group: "提取",
      run: () => runRefactor(kind as keyof typeof REFACTOR_KINDS),
    });
  }
  items.push({
    id: "refactor.workbench.extract.parameter",
    label: "提取参数",
    hint: "把方法里用到的表达式提升为参数 · Ctrl+Alt+P",
    group: "提取",
    run: () => runExtractParameter(),
  });
  const workbench: { kind: WorkbenchRefactor; hint: string }[] = [
    { kind: "inlineVariable", hint: "把变量替换成它的值，删掉声明" },
    { kind: "inlineMethod", hint: "把调用点替换成方法体，删掉方法" },
    { kind: "signature", hint: "改方法名、参数顺序、增删参数，调用点一起改" },
    { kind: "moveType", hint: "把类移到另一个包，引用一起改" },
    { kind: "renamePackage", hint: "移动整包并重命名，Java 与 XML 一起搬" },
    { kind: "visibility", hint: "把字段或方法改成 public / protected / private" },
    { kind: "structure", hint: "按 Java 语法结构搜索，可生成替换预览" },
    { kind: "batchFix", hint: "整个模块扫一遍问题，或批量整理导入" },
  ];
  for (const { kind, hint } of workbench) {
    const group: RefactorMenuGroup =
      kind === "inlineVariable" || kind === "inlineMethod"
        ? "内联"
        : kind === "structure" || kind === "batchFix"
          ? "批量与搜索"
          : "移动与重命名";
    items.push({
      id: `refactor.workbench.${kind}`,
      label: REFACTOR_LABELS[kind],
      hint,
      group,
      run: () => openRefactorWorkbench(kind),
    });
  }
  return items;
}

interface MenuState {
  open: boolean;
}
let state: MenuState = { open: false };
const listeners = new Set<() => void>();
function publish(next: MenuState) {
  state = next;
  for (const fn of listeners) fn();
}
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export const useRefactorMenu = () => useSyncExternalStore(subscribe, () => state, () => state);
export function closeRefactorMenu(): void {
  if (state.open) publish({ open: false });
}

/**
 * 唯一入口（Alt+Shift+T / Ctrl+Alt+Shift+T / 命令面板「重构…」）。
 *
 * 守卫放在这里而不是菜单里：用户按了键却什么都没发生是最糟的体验，
 * 三种不可用原因各给一句能照做的提示。
 */
export function openRefactorMenu(): void {
  const selection = currentSelection();
  const path = selection ? pathOfModel(selection.model) : undefined;
  if (!selection || !path || selection.readOnly || selection.model.getLanguageId() !== "java") {
    toast("请先在可编辑的 Java 文件里放光标或选中代码", "info");
    return;
  }
  if (!langReady()) {
    toast("代码智能还没就绪，重构需要它算改动范围；稍等或点状态栏的代码智能", "warning");
    return;
  }
  publish({ open: true });
}

export function registerRefactorMenuCommand(): () => void {
  return registerCommands([
    { id: "refactor.menu", title: "重构…", run: () => openRefactorMenu(), enabled: () => langReady() },
  ]);
}
