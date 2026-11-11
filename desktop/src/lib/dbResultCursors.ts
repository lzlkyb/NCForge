import { dbApi } from "./dbApi";

interface ResultCursor { connId: string; slot: string | null; tabId: string }
const cursors = new Map<string, ResultCursor>();

export function registerResultCursor(resultId: string, connId: string, slot: string | null, tabId: string) {
  cursors.set(resultId, { connId, slot, tabId });
}
export function ownsResultCursor(resultId: string, connId: string, slot?: string | null) {
  const cursor = cursors.get(resultId);
  return cursor?.connId === connId && cursor.slot === (slot ?? null);
}
export function hasResultCursor(resultId: string) { return cursors.has(resultId); }

export async function closeResultCursor(resultId: string) {
  const cursor = cursors.get(resultId);
  if (!cursor) return;
  // 先作废本地身份，正在返回的续取不会再写入已经释放的结果。
  cursors.delete(resultId);
  try { await dbApi.closeResult(cursor.connId, cursor.slot, resultId); }
  catch { /* 断开或回收会话已经释放服务端资源，已读取数据仍可保留。 */ }
}
export async function closeTabResultCursors(tabId: string) {
  for (const [id, cursor] of [...cursors]) if (cursor.tabId === tabId) await closeResultCursor(id);
}
/** 后端在会话/只读/schema 变化时已关闭这些游标；这里只同步本地身份。 */
export function invalidateResultCursors(connId: string, slot?: string | null) {
  for (const [id, cursor] of cursors) {
    if (cursor.connId === connId && (slot === undefined || cursor.slot === slot)) cursors.delete(id);
  }
}
export function resetResultCursors() { cursors.clear(); }
