/**
 * 文件树「外部改动 → 重读目录」的调度器。
 *
 * 为什么需要：编译 / SVN 更新 / 解压时后端每秒都可能报一批目录，`rescan` 更是把所有
 * 读过的目录一次全甩出来。原来每个目录各自并发读盘、各自写一次树状态：几百个 IPC
 * 同时飞、几百次整棵树重渲染。这里改成：
 * - 同时最多 `limit` 个目录在读；
 * - 一轮读完只 `apply` 一次（整批写进树）；
 * - 一轮进行中又来的请求按路径去重，放到下一轮——已经在读的目录也要再读一次，
 *   因为新事件可能发生在它读盘之后。
 */
export function createDirRefresher<T>(opts: {
  read: (dir: string) => Promise<T>;
  apply: (results: Map<string, T>) => void;
  limit?: number;
}) {
  const limit = Math.max(1, opts.limit ?? 4);
  const queued = new Set<string>();
  let running: Promise<void> | null = null;

  async function round(batch: string[]) {
    const out = new Map<string, T>();
    let next = 0;
    const worker = async () => {
      while (next < batch.length) {
        const dir = batch[next++];
        out.set(dir, await opts.read(dir));
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, batch.length) }, worker));
    // 按请求顺序交出去，结果对调用方是确定的
    opts.apply(new Map(batch.filter((d) => out.has(d)).map((d) => [d, out.get(d) as T])));
  }

  async function pump() {
    try {
      while (queued.size > 0) {
        const batch = [...queued];
        queued.clear();
        await round(batch);
      }
    } finally {
      running = null;
    }
  }

  return {
    /** 排进待读队列；返回本轮（含后续合并进来的轮次）全部完成的 Promise。 */
    request(dirs: Iterable<string>): Promise<void> {
      for (const d of dirs) queued.add(d);
      if (!running && queued.size > 0) running = pump();
      return running ?? Promise.resolve();
    },
  };
}
