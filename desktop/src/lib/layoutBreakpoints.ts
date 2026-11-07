/**
 * 响应式布局断点（窗口宽度 px）。
 *
 * 与 CSS 的 `@media(max-width:…)` 必须同值，否则 JS 的 matchMedia 判定和样式表
 * 会在同一个窗口宽度上给出不同答案（典型症状：窄窗侧栏还没变成抽屉，Esc 已经
 * 不去关闭它了）。四档收敛为：
 *
 * - `sm` 640：侧栏脱离网格变成抽屉、状态栏降级
 * - `md` 900：工具栏隐藏说明文字、设置页左右分栏退化为上下
 * - `lg` 1200：搜索框收窄、文档工具条换行
 * - `xl` 1600：宽屏留白（不改结构）
 *
 * 改这里之前先 grep 全库 `max-width:`，四处要一起改。
 */
export const BREAKPOINTS = { sm: 640, md: 900, lg: 1200, xl: 1600 } as const;
export const BP_SM = BREAKPOINTS.sm;
export const BP_MD = BREAKPOINTS.md;
export const BP_LG = BREAKPOINTS.lg;
export const BP_XL = BREAKPOINTS.xl;
