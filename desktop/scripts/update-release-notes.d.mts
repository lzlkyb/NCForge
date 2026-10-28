// update-release-notes.mjs 的类型声明（.mjs ↔ .d.mts 配对）。
// 存在的意义：src/lib/updateNotes.test.ts 跨侧 import HISTORY_MARKER 锁死
// 「写入侧标记 ↔ 读取侧正则」的协议契约，tsc 需要这份声明才不报 TS7016。
export declare const HISTORY_MARKER: string;
export declare function buildUpdateNotes(notes: string, version: string, changelog: string): string;
