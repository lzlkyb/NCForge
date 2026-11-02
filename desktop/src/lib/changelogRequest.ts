/**
 * 从外部打开设置页的「更新历史」弹窗。
 *
 * 升级欢迎条（UpgradeWelcomeBar）挂在 App 壳上，而入口与弹窗状态都在 SettingsTab
 * 内部——和 openFileRequest 一样，先发一个单向请求；设置页是懒加载的，挂载前发的
 * 请求先存着，等它挂载后自己取走。
 */
let pending = false;
const listeners = new Set<() => void>();

export function requestOpenChangelog(): void {
  if (listeners.size === 0) {
    pending = true;
    return;
  }
  listeners.forEach((cb) => cb());
}

/** 取走挂载前攒下的请求（只取一次）。 */
export function consumePendingChangelog(): boolean {
  const p = pending;
  pending = false;
  return p;
}

export function onOpenChangelogRequest(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
