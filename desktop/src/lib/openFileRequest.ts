/**
 * 跨页面「打开文件并定位到行」的请求通道。
 *
 * 为什么需要它：页面状态各自封闭（`FilesTab` 的标签列表是它自己的 useState），
 * 搜索页没法直接调它的 `openFile`。这里只做一个单向管道：任意页面 request，
 * `FilesTab` 消费。
 *
 * `pending` 兜住「请求发出时 FilesTab 还没挂载」这一拍：App 先切页再渲染，
 * 而 FilesTab 是 lazy 组件，订阅会晚于事件。所以先存下来，等它挂载后自己取走。
 */
export interface OpenFileRequest {
  /** 绝对路径（Windows 反斜杠）。 */
  path: string;
  /** 要定位到的行号；不给就只打开。 */
  line?: number;
  /** 要定位到的列号（1 基）。只有搜索命中这类知道行内位置的调用方会给。 */
  column?: number;
}

/**
 * 挂载前攒下的请求。**用队列不用单值**：结果页连点两条命中时页面可能还没挂载，
 * 只留最后一条会让前一次打开直接消失（用户点了两次，只开了一个文件）。
 * 上限只防极端刷新，正常一次最多两三条。
 */
const MAX_PENDING = 8;
const pending: OpenFileRequest[] = [];
const listeners = new Set<(req: OpenFileRequest) => void>();

/** 请求打开文件。已有订阅者就直接派发，否则先存着等 `consumePendingOpen`。 */
export function requestOpenFile(req: OpenFileRequest): void {
  if (listeners.size === 0) {
    pending.push(req);
    if (pending.length > MAX_PENDING) pending.shift();
    return;
  }
  listeners.forEach((cb) => cb(req));
}

/** 取走挂载前攒下的下一条请求（一次一条，取空返回 null）。 */
export function consumePendingOpen(): OpenFileRequest | null {
  return pending.shift() ?? null;
}

/** 订阅打开请求。返回取消订阅函数。 */
export function onOpenFileRequest(cb: (req: OpenFileRequest) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
