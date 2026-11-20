// 常驻共享大纲 worker。
//
// 以前 useLocalOutline / documentOutlineModel 每次解析各 new 一个 module Worker：
// 实例化几十毫秒，连续编辑时反复创建销毁，解析本身才几毫秒。现在进程内只留一个
// 常驻实例，请求按 id 区分；陈旧守卫仍由调用方做（版本 / 模型同一性）。
import type { FlatSymbol } from "./symbols";

type Reply = { id: number; symbols: FlatSymbol[] };
type Waiter = { ok: (symbols: FlatSymbol[]) => void; err: () => void };

let worker: Worker | null = null;
let nextId = 1;
const waiting = new Map<number, Waiter>();

function ensure(): Worker | null {
  if (typeof Worker === "undefined") return null;
  if (worker) return worker;
  worker = new Worker(new URL("./outlineWorker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent<Reply>) => {
    const waiter = waiting.get(event.data.id);
    if (waiter) {
      waiting.delete(event.data.id);
      waiter.ok(event.data.symbols);
    }
  };
  worker.onerror = () => {
    // 实例异常：重建留到下次请求；在途请求按失败通知，调用方才能清掉 pending 重试。
    const dead = worker;
    worker = null;
    const entries = [...waiting.values()];
    waiting.clear();
    dead?.terminate();
    for (const w of entries) w.err();
  };
  return worker;
}

/**
 * 提交一次大纲解析。返回取消函数：取消后回包不再回调（调用方卸载 / 新编辑时用）。
 * Worker 不可用时返回空操作，调用方自行走同步回退。
 */
export function requestOutline(
  path: string,
  text: string,
  onResult: (symbols: FlatSymbol[]) => void,
  onError?: () => void,
): () => void {
  const w = ensure();
  if (!w) return () => {};
  const id = nextId++;
  waiting.set(id, { ok: onResult, err: onError ?? (() => {}) });
  w.postMessage({ id, path, text });
  return () => {
    waiting.delete(id);
  };
}
