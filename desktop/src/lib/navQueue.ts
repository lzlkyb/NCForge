/**
 * 历史跳转的串行队列（L16）。
 *
 * 🔴 为什么需要它：`navLook` 只看游标、**不动游标**（先看后落，见 `navHistory`），
 * 所以连点两次「后退」会拿到同一个目标；而 `openAt`/`openJdt` 内部用抢号
 * （revealSeq / openSeq）让先发的那次返回 false ⇒ 两次都不 `navCommit`，
 * 用户点了两下却停在原地。deferred 标签（后台恢复的页签）走异步读盘，稳定复现。
 *
 * 这里**排队**而不是丢弃后一次点击：第二下进队，等第一下落定后才换算目标，
 * 于是两下退两格。相对量必须在出队时才求值，否则第二次仍指向旧游标的邻居。
 *
 * 纯逻辑、不依赖 React：`step` 由调用方提供（它要读最新的 tabs / 编辑器组），
 * 返回 false 表示「没有可跳的目标」（到头了 / 目标就是当前点），此时清空剩余队列，
 * 免得连点十下在边界上空转十次异步打开。
 */

/** 一次跳转请求：`delta` 相对当前游标，`index` 是历史列表的绝对下标。 */
export type NavRequest = { delta: -1 | 1 } | { index: number };

/**
 * @param step 执行一次跳转；返回是否真的跳了（false = 没有目标，队列作废）
 * @returns 入口函数。返回的 promise 在**整条队列**收尾后 resolve，调用方能 await
 *          到「自己这一下真的落定了」——忙时进来的请求拿到的是同一条链的尾巴。
 */
export function createNavQueue(step: (req: NavRequest) => Promise<boolean>): (req: NavRequest) => Promise<void> {
  let busy = false;
  let tail: Promise<void> | undefined;
  const queue: NavRequest[] = [];
  const go = (req: NavRequest): Promise<void> => {
    if (busy) {
      queue.push(req);
      return tail ?? Promise.resolve();
    }
    busy = true;
    const chain = (async () => {
      let next: NavRequest | undefined = req;
      while (next !== undefined) {
        if (!(await step(next))) { queue.length = 0; break; }
        next = queue.shift();
      }
    })().finally(() => {
      busy = false;
      tail = undefined;
      // 收尾期间又进来的请求不能丢：它们排在刚结束的这条链之后，重新起一条
      const rest = queue.shift();
      if (rest !== undefined) void go(rest);
    });
    tail = chain;
    return chain;
  };
  return go;
}
