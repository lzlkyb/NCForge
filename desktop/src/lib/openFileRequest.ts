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
}

let pending: OpenFileRequest | null = null;
const listeners = new Set<(req: OpenFileRequest) => void>();

/** 请求打开文件。已有订阅者就直接派发，否则先存着等 `consumePendingOpen`。 */
export function requestOpenFile(req: OpenFileRequest): void {
  if (listeners.size === 0) {
    pending = req;
    return;
  }
  listeners.forEach((cb) => cb(req));
}

/** 取走挂载前攒下的请求（只取一次）。 */
export function consumePendingOpen(): OpenFileRequest | null {
  const p = pending;
  pending = null;
  return p;
}

/** 订阅打开请求。返回取消订阅函数。 */
export function onOpenFileRequest(cb: (req: OpenFileRequest) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
