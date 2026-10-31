import type { ExecStats } from "./dbApi";
import { thousands } from "./db";

/**
 * Autotrace 统计行的文案（A2）。
 *
 * **`null` 就是不显示**：账号读不到 `v$mystat` 时后端给 `stats: null`，界面必须整行
 * 消失，而不是显示「逻辑读 0」——那会让人以为这条慢 SQL 一次读都没花。
 */

/** 结果底栏那一行：`逻辑读 1,234 · 物理读 0`。读不到统计返回 null。 */
export function statsText(s: ExecStats | null | undefined): string | null {
  if (!s) return null;
  return `逻辑读 ${thousands(s.logicalReads)} · 物理读 ${thousands(s.physicalReads)}`;
}

/** 悬停明细：把当前读 / 一致读 / 执行次数摊开（对数图时有用）。 */
export function statsTitle(s: ExecStats | null | undefined): string | null {
  if (!s) return null;
  return [
    `逻辑读 = 当前读 ${thousands(s.dbBlockGets)} + 一致读 ${thousands(s.consistentGets)}`,
    `物理读 ${thousands(s.physicalReads)}`,
    `执行次数 ${thousands(s.executeCount)}`,
    "含本次统计查询自身的开销（与 autotrace 同口径）",
  ].join("\n");
}
