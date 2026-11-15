// VO ↔ 表 ↔ 字段的反向查询（B3）。
//
// 正向（表 → VO）在数据字典里；这里解决现场更常见的问法：
// 「我正在看这个 VO，它到底是哪张表、哪个字段」。
// 只认库里真有的映射（md_ormap），不做类名推断——推断错九次对一次，代价是改错表。
import { useSyncExternalStore } from "react";
import { invoke } from "./tauri";
import { editorSnapshot } from "./editorActions";
import { javaGenerationModel } from "./javaGenerationModel";
import type { TableDict } from "./mdDict";

export interface VoTableOut {
  className: string;
  /** 库里命中的全限定类名，可能不止一个（同名类在不同包）。 */
  voNames: string[];
  tables: TableDict[];
  notes: string[];
  source: string;
  elapsedMs: number;
}

/** 查这个 VO 对应的表。`connId` 不传就用当前数据库连接。 */
export const voTables = (className: string, connId?: string | null) =>
  invoke<VoTableOut>("nc_vo_tables", { id: connId ?? null, className });

/**
 * 当前编辑器里光标所在的类名（最内层类）。
 *
 * 用解析出的类名而不是「文件名」：NC 的一个文件常有多个类，
 * 文件名和用户眼前的那个类对不上时，查错表比查不到更糟。
 */
export function currentClassName(): string | null {
  const snap = editorSnapshot();
  if (!snap?.isJava) return null;
  const model = javaGenerationModel(snap.text, snap.line, snap.column);
  return model?.name ?? null;
}

// ── 弹窗请求 ──────────────────────────────────────────
// 命令（键盘/命令面板）与弹窗组件分别挂在两棵树上，中间用一个单例转达：
// 引入一个全局 Provider 只为了传一个类名，代价比这大。

let pending: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function openVoTableDialog(className: string): void {
  pending = className;
  emit();
}

export function closeVoTableDialog(): void {
  pending = null;
  emit();
}

export function useVoTableRequest(): string | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => pending,
  );
}
