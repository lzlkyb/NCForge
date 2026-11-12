/**
 * 对象定义（DDL）的进程内缓存。
 *
 * 为什么需要：一次表 DDL 的往返实测 740ms 起（31 个索引的表），481 列的宽表 1.15s；
 * 而 `MetaText` 每次从别的页签切回来都会重新挂载、重新拉一遍。切来切回去看同一张表
 * 是最常见的动作，缓存把第 2..N 次降到 0。
 *
 * 失效只有三个入口，宁可多发一次也不给过期结构：
 * - 工具栏的「刷新」（显式失效这一个对象）
 * - 连接断开 / 重连（`dropDdl(connId)`）
 * - 在该连接上执行了 DDL 语句（`dropDdl(connId)`，结构可能已变）
 */
const LIMIT = 120;
const cache = new Map<string, string>();

/** 缓存键：同一个名字在不同 schema / 不同类型下是完全不同的对象。 */
export function ddlKey(connId: string, table: string, otype?: string | null, schema?: string): string {
  return [connId, (schema ?? "").toUpperCase(), (otype ?? "TABLE").toUpperCase(), table.toUpperCase()].join("|");
}

/** 命中就把它挪到队尾（LRU 触碰），未命中返回 undefined（DDL 可能是空串，不能用 falsy 判断）。 */
export function readDdl(key: string): string | undefined {
  const hit = cache.get(key);
  if (hit === undefined) return undefined;
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

export function writeDdl(key: string, text: string): void {
  cache.delete(key);
  cache.set(key, text);
  if (cache.size <= LIMIT) return;
  const oldest = cache.keys().next();
  if (!oldest.done) cache.delete(oldest.value);
}

/** 不传 connectionId = 全清。 */
export function dropDdl(connId?: string): void {
  if (!connId) {
    cache.clear();
    return;
  }
  const prefix = `${connId}|`;
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

/** 测试用：读当前条数。 */
export function ddlCacheSize(): number {
  return cache.size;
}
