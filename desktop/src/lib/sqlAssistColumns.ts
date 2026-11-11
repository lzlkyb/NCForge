import { columnsOf } from "./dbStore";
import type { ColumnInfo } from "./dbApi";

interface Waiter { current: () => boolean; resolve: (columns: ColumnInfo[]) => void; reject: (error: Error) => void }
interface Request { key: string; connId: string; table: string; running: boolean; waiters: Waiter[] }
const requests = new Map<string, Request>(), queue: Request[] = [];
const MAX_ACTIVE = 2, MAX_QUEUE = 16;
let active = 0;
const expired = () => new Error("SQL 字段读取已过期");
function valid(current: () => boolean): boolean { try { return current(); } catch { return false; } }
function keepCurrent(request: Request): boolean {
  request.waiters = request.waiters.filter(waiter => {
    if (valid(waiter.current)) return true;
    waiter.reject(expired()); return false;
  });
  return request.waiters.length > 0;
}
function forget(request: Request) { if (requests.get(request.key) === request) requests.delete(request.key); }
function pruneQueue() {
  for (let i = queue.length - 1; i >= 0; i--) if (!keepCurrent(queue[i])) { forget(queue[i]); queue.splice(i, 1); }
}
function finish(request: Request, columns?: ColumnInfo[], error?: unknown) {
  forget(request); active--;
  for (const waiter of request.waiters) {
    if (!valid(waiter.current)) waiter.reject(expired());
    else if (columns) waiter.resolve(columns);
    else waiter.reject(error instanceof Error ? error : new Error("SQL 字段读取失败"));
  }
  request.waiters = []; pump();
}
function pump() {
  while (active < MAX_ACTIVE && queue.length) {
    const request = queue.shift()!;
    if (!keepCurrent(request)) { forget(request); continue; }
    request.running = true; active++;
    try { Promise.resolve(columnsOf(request.connId, request.table)).then(columns => finish(request, columns), error => finish(request, undefined, error)); }
    catch (error) { finish(request, undefined, error); }
  }
}

/** One shared metadata gate; each subscriber retains its own model/schema freshness check. */
export function sqlAssistColumns(connId: string, table: string, current: () => boolean, priority = false): Promise<ColumnInfo[]> {
  if (!valid(current)) return Promise.reject(expired());
  pruneQueue();
  const key = JSON.stringify([connId, table]);
  let request = requests.get(key);
  // A new context must not join a stale in-flight read for the same connection id.
  if (request && !keepCurrent(request)) {
    forget(request);
    if (!request.running) queue.splice(queue.indexOf(request), 1);
    request = undefined;
  }
  if (!request && active >= MAX_ACTIVE && queue.length >= MAX_QUEUE) return Promise.reject(new Error("SQL 字段读取队列已满"));
  return new Promise((resolve, reject) => {
    const waiter: Waiter = { current, resolve, reject };
    if (request) {
      request.waiters.push(waiter);
      if (priority && !request.running) { const index = queue.indexOf(request); if (index >= 0) queue.splice(index, 1); queue.unshift(request); }
    } else {
      request = { key, connId, table, running: false, waiters: [waiter] }; requests.set(key, request);
      if (priority) queue.unshift(request); else queue.push(request);
    }
    pump();
  });
}
