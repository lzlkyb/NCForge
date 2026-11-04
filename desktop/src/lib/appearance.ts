import { APP_SLUG } from "./about";

/** 界面材质独立于明暗与终端配色；只切根节点属性，保留页面和会话节点。 */
export type Appearance = "classic" | "glass";

const KEY = `${APP_SLUG}.ui-style`;
const EVENT = "appearancechange";
let appearanceRevision = 0;

export function getStoredAppearance(): Appearance {
  try {
    return localStorage.getItem(KEY) === "glass" ? "glass" : "classic";
  } catch {
    return "classic";
  }
}

export function getAppearance(): Appearance {
  return document.documentElement.dataset.uiStyle === "glass" ? "glass" : "classic";
}

/** 挂载前恢复已选材质；新用户使用一体化实色界面，初始化不覆盖已存选择。 */
export function initializeAppearance(): void {
  document.documentElement.dataset.uiStyle = getStoredAppearance();
}

/** 返回是否成功记住选择；存储不可用时，本次切换仍然生效。 */
export function applyAppearance(appearance: Appearance): boolean {
  const changed = getAppearance() !== appearance;
  const root = document.documentElement;
  const revision = ++appearanceRevision;
  const finish = () => { if (revision === appearanceRevision) delete root.dataset.materialTransitions; };
  const paint = () => {
    // 快速切回时，尚未执行的快照回调不能覆盖用户最后一次选择。
    if (revision !== appearanceRevision) return;
    const shouldNotify = getAppearance() !== appearance;
    root.dataset.uiStyle = appearance;
    if (shouldNotify) window.dispatchEvent(new Event(EVENT));
  };
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (changed && !reduced && !document.hidden && document.startViewTransition) {
    root.dataset.materialTransitions = "";
    try {
      const transition = document.startViewTransition(paint);
      void transition.ready.catch(() => {});
      void transition.finished.then(finish, finish);
    } catch {
      // 快照接口不可用时仍完成切换，偏好保存与视觉反馈不能被动效阻断。
      paint();
      finish();
    }
  } else {
    paint();
    finish();
  }
  let persisted = true;
  try {
    localStorage.setItem(KEY, appearance);
  } catch {
    persisted = false;
  }
  return persisted;
}

export function subscribeAppearance(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
