import { APP_SLUG } from "./about";

/**
 * 界面密度三档（DESIGN.md R3）。
 *
 * compact  —— 小屏 / 多编辑器组 / 网格与日志并排时用，牺牲留白换可见行数；
 * standard —— 默认；
 * comfortable —— 大屏、演示、触摸。
 *
 * 几何由 index.css「几何档位矩阵」统一给出（--h-control / --h-icon），
 * 字号与行高的档位差异在 interaction-density.css 里按 data-ui-density 生效。
 * 存储值不认识时一律回落 standard：旧版本写进去的脏值不能让界面变成无档状态。
 */
export type UiDensity = "compact" | "standard" | "comfortable";

export const UI_DENSITIES: readonly UiDensity[] = ["compact", "standard", "comfortable"];

/**
 * 虚拟列表行几何（像素）。必须与 index.css 矩阵里的 `--row-h` 同值：
 * CSS 那份供纯 CSS 布局用，这份供 JS 虚拟滚动算 offset——两边不一致就会出现
 * "行高变了但滚动位置错位"。
 */
export const DENSITY_ROW_H: Record<UiDensity, number> = { compact: 22, standard: 26, comfortable: 30 };

/** 网格表头高度（与行高同源，表头额外容纳排序图标与筛选入口）。 */
export const DENSITY_HEAD_H: Record<UiDensity, number> = { compact: 36, standard: 40, comfortable: 44 };

const DEFAULT_DENSITY: UiDensity = "standard";
const KEY = `${APP_SLUG}.ui-density`;
const EVENT = "ui-density-change";

export function normalizeDensity(value: string | null | undefined): UiDensity {
  return UI_DENSITIES.includes(value as UiDensity) ? (value as UiDensity) : DEFAULT_DENSITY;
}

export function getStoredUiDensity(): UiDensity {
  try {
    return normalizeDensity(localStorage.getItem(KEY));
  } catch {
    return DEFAULT_DENSITY;
  }
}

export function getUiDensity(): UiDensity {
  return normalizeDensity(document.documentElement.dataset.uiDensity);
}

/** 编辑器保留自己的字号；虚拟列表接入密度时须同时订阅变化并同步行几何。 */
export function initializeUiDensity(): void {
  document.documentElement.dataset.uiDensity = getStoredUiDensity();
}

export function applyUiDensity(density: UiDensity): boolean {
  const next = normalizeDensity(density);
  const changed = getUiDensity() !== next;
  document.documentElement.dataset.uiDensity = next;
  let saved = true;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    saved = false;
  }
  if (changed) window.dispatchEvent(new Event(EVENT));
  return saved;
}

export function subscribeUiDensity(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
