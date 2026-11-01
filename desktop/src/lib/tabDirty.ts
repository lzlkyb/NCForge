import type { TabMeta } from "./workspaceSession";

/**
 * 「这个标签有没落盘的修改」——全项目唯一判定。
 *
 * 单独一个小模块（只依赖类型）的原因：`saveAllDirty` 那头连着 `fileSave → editorStore
 * → monacoSetup`，文件树、标签条这类只想问一句「脏不脏」的地方引它，会把整个 Monaco
 * 拖进模块图（jsdom 测试直接挂）。这里没有运行时依赖，谁都能静态引。
 *
 * `eolChanged` 也算未保存——内容没变，但保存后行尾会跟着改，同样是用户还没落盘的意图。
 */
export function isUnsaved(t: TabMeta): boolean {
  return !t.readOnly && !t.virtual && (t.dirty || t.eolChanged);
}
