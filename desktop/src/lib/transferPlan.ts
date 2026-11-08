/**
 * 表 → 表 直连搬运的共享类型与判据。
 *
 * 「能不能搬」这件事必须**在按按钮之前**就看清楚：搬一半停下来、或者把 CLOB 截断成 8K
 * 搬过去，都是事后没法自证的错误。所以这里只放两个纯函数——把后端的计划翻成人话。
 */

export interface TransferEndpoint {
  id: string;
  owner: string;
  table: string;
}

export interface TransferColumnPair {
  from: string;
  to: string;
  /** 目标列类型（后端拼字面量用，界面只显示）。 */
  ty: string;
}

export interface TransferPlan {
  pairs: TransferColumnPair[];
  /** 源有、目标没有的列：不会搬。 */
  skipped: string[];
  /** 目标有、源没有的列：搬过去是 NULL。 */
  extra: string[];
  /** 两侧都有的 LOB 列：搬运会被截断，整次挡住。 */
  lobs: string[];
}

export interface TransferRowsOut {
  copied: number;
  batches: number;
  cleared: boolean;
  canceled: boolean;
  ms: number;
}

/** 拦下整次搬运的原因；`null` 表示可以搬。 */
export function planBlocker(plan: TransferPlan | null): string | null {
  if (!plan) return "还没读到两侧的列，先算一遍映射";
  if (plan.pairs.length === 0) return "两侧没有同名同序列，搬不了（先对比结构看差在哪）";
  if (plan.lobs.length > 0) {
    return `这些列是大对象（${plan.lobs.join("、")}）：搬运走结果集预览通道，CLOB 只有前 8K，搬过去会静默截断。请改用「导出 INSERT 脚本」`;
  }
  return null;
}

/** 一句话总结计划（界面上那行灰字）。 */
export function planNote(plan: TransferPlan): string {
  const parts = [`搬 ${plan.pairs.length} 列`];
  if (plan.skipped.length > 0) parts.push(`源表另有 ${plan.skipped.length} 列目标没有，不搬`);
  if (plan.extra.length > 0) parts.push(`目标表另有 ${plan.extra.length} 列会写 NULL`);
  return parts.join(" · ");
}
