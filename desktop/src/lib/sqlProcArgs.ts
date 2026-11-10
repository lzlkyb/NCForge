import { dbApi, type ProcArguments } from "./dbApi";

/**
 * 过程参数的按连接缓存。
 *
 * 单独一个模块是为了让「签名帮助」和「刷新对象 / 断开重连」都能拿到同一份缓存：
 * 放进 `sqlProviders`（Monaco 接线）会让 `dbActions` 反向依赖编辑器层，
 * 落进已有的 `dbActions ⇄ sqlProviders` 循环里。
 *
 * 只缓存成功结果：会话刚建、字典被 DDL 锁住都会失败一次，把失败也缓存起来
 * 会让用户「再敲一次还是没有提示」。
 */

const CACHE_MAX = 400;

const cache = new Map<string, ProcArguments>();

const keyOf = (connId: string, name: string) => `${connId}|${name.toLowerCase()}`;

export async function procArguments(connId: string, name: string): Promise<ProcArguments | null> {
  const key = keyOf(connId, name);
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    const data = await dbApi.arguments(connId, name);
    // 满了一整批清掉：这些都是小对象，LRU 记账不值得，简单粗暴比留个会漏的链表好
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(key, data);
    return data;
  } catch {
    return null;
  }
}

/** 元数据变了（刷新对象 / 断开重连 / 切 schema）后清缓存；不传 `connId` 清全部。 */
export function forgetProcArguments(connId?: string): void {
  if (!connId) {
    cache.clear();
    return;
  }
  const prefix = `${connId}|`;
  for (const k of [...cache.keys()]) {
    if (k.startsWith(prefix)) cache.delete(k);
  }
}
