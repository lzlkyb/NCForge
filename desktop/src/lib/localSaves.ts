/**
 * 最近由本应用保存过的文件。
 *
 * 文件监听会把「我们自己刚写完的 .java」也当成外部改动报上来；如果照单全收，
 * 一次 Ctrl+S 会先触发保存后的快速编译，700ms 后再被监听触发一遍——两次 JVM、
 * 两条进度，用户看到的是「保存怎么编了两次」。
 *
 * 只做时间窗抑制，不追求精确：窗口内另一程序恰好改了同一文件会少编一次，
 * 下一次保存或手动编译会补上；反过来（漏抑制）是每次保存都多跑一轮，代价更大。
 */

/** 保存到监听事件到达之间的窗口。慢盘 + 防病毒扫描时可能到几秒。 */
export const LOCAL_SAVE_WINDOW_MS = 8_000;
const MAX_TRACKED = 256;

const recent = new Map<string, number>();

/**
 * 保存事件的订阅（改动时间线 B1 用）。与抑制窗口无关，resetLocalSaves 不清订阅。
 *
 * `versionId` = 本轮**写盘前**归档出的本地历史版本 id（没归档到就是 undefined）。
 * 轮基线靠它精确定位，不再用时间戳猜——猜的话必差一版。
 */
const saveListeners = new Set<(path: string, versionId?: string) => void>();
export function onLocalSave(cb: (path: string, versionId?: string) => void): () => void {
  saveListeners.add(cb);
  return () => { saveListeners.delete(cb); };
}

const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();

/**
 * 保存开始前调用（而不是成功后）：监听事件可能比 IPC 返回先到。
 * **只设抑制窗口，不发保存事件**——写盘可能失败（冲突 / 编码写不出），
 * 那时文件没落盘，多一条幻影轮还会把已审角标连带后端标记一起清掉。
 */
export function markLocalSave(path: string): void {
  const key = norm(path);
  recent.set(key, Date.now());
  if (recent.size <= MAX_TRACKED) return;
  // 只清过期项；都在窗口内就按插入顺序丢最旧的一批
  const now = Date.now();
  for (const [k, t] of recent) {
    if (now - t > LOCAL_SAVE_WINDOW_MS) recent.delete(k);
    else if (recent.size > MAX_TRACKED) recent.delete(k);
  }
}

/**
 * 写盘**成功后**发保存事件（由 `fileSave.saveOne` 调，覆盖 Ctrl+S / 转 UTF-8 /
 * 退出前保存全部 / 提交前保存所有路径）。抑制窗口仍由 markLocalSave 在写盘前设。
 */
export function notifyLocalSave(path: string, versionId?: string): void {
  saveListeners.forEach((cb) => cb(path, versionId));
}

export function isRecentLocalSave(path: string, windowMs = LOCAL_SAVE_WINDOW_MS): boolean {
  const t = recent.get(norm(path));
  return t !== undefined && Date.now() - t <= windowMs;
}

/** 测试用：清空。 */
export function resetLocalSaves(): void {
  recent.clear();
}
