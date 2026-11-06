import { useSyncExternalStore } from "react";
import type { PanelTab } from "../components/workspace/BottomPanel";
import { setSideOpen } from "./layoutStore";
import { setSession } from "./workspaceSession";

export type WorkbenchMode = "code" | "diagnose" | "debug";
export interface WorkbenchLayout {
  mode: WorkbenchMode;
  locked: boolean;
  side: number;
  sides: Partial<Record<string, number>>;
  heights: Partial<Record<PanelTab, number>>;
  pinned: PanelTab[];
  expanded: PanelTab | null;
  compact: boolean;
}
export const WORKBENCH_MODES: { id: WorkbenchMode; label: string }[] = [
  { id: "code", label: "编码布局" }, { id: "diagnose", label: "排错布局" }, { id: "debug", label: "调试布局" },
];
export const PRIMARY_PANELS: PanelTab[] = ["problems", "build", "svc", "debug"];
export const SECONDARY_PANELS: PanelTab[] = ["calls", "types", "todo", "bookmarks"];
const KEY = "ncforge-workbench-layout";
const DEFAULTS: WorkbenchLayout = { mode: "code", locked: false, side: 240, sides: {}, heights: {}, pinned: [], expanded: null, compact: true };
const listeners = new Set<() => void>();
const clamp = (value: unknown, min: number, max: number, fallback: number) => typeof value === "number" && Number.isFinite(value) ? Math.round(Math.min(max, Math.max(min, value))) : fallback;

export function parseWorkbenchLayout(raw: string | null, legacy: string | null = null): WorkbenchLayout {
  try {
    const value = raw ? JSON.parse(raw) : {};
    const old = !raw && legacy ? JSON.parse(legacy) : {};
    const heights: WorkbenchLayout["heights"] = {};
    const sides: WorkbenchLayout["sides"] = {};
    for (const key of ["files", "search", "svn", "db", "settings"]) if (typeof value.sides?.[key] === "number") sides[key] = clamp(value.sides[key], 180, 420, 240);
    for (const panel of [...PRIMARY_PANELS, ...SECONDARY_PANELS]) {
      if (typeof value.heights?.[panel] === "number") heights[panel] = clamp(value.heights[panel], 140, 1200, 200);
    }
    // The old shared height belongs to general output, not every future tool.
    if (!raw && typeof old.bottom === "number") heights.problems = heights.build = clamp(old.bottom, 140, 1200, 200);
    return { ...DEFAULTS, mode: WORKBENCH_MODES.some(m => m.id === value.mode) ? value.mode : "code", locked: value.locked === true,
      side: clamp(value.side ?? old.side, 180, 420, 240), sides, heights,
      pinned: SECONDARY_PANELS.filter(p => Array.isArray(value.pinned) && value.pinned.includes(p)) };
  } catch { return { ...DEFAULTS, heights: {}, pinned: [] }; }
}
function load() {
  try { return parseWorkbenchLayout(localStorage.getItem(KEY), localStorage.getItem("ncforge-workbench-sizes")); }
  catch { return parseWorkbenchLayout(null); }
}
let snapshot = load();
let persistTimer: ReturnType<typeof setTimeout> | undefined;
const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
export const getWorkbenchLayout = () => snapshot;
export const useWorkbenchLayout = () => useSyncExternalStore(subscribe, getWorkbenchLayout, getWorkbenchLayout);
export function updateWorkbenchLayout(patch: Partial<WorkbenchLayout>): void {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach(cb => cb());
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    // Resizing stays in memory per frame; temporary reading expansion is never restored on launch.
    try { localStorage.setItem(KEY, JSON.stringify({ mode: snapshot.mode, locked: snapshot.locked, side: snapshot.side, sides: snapshot.sides, heights: snapshot.heights, pinned: snapshot.pinned })); } catch { /* Session state still works when persistence is unavailable. */ }
  }, 300);
}
export function selectWorkbenchLayout(mode: WorkbenchMode): void {
  updateWorkbenchLayout({ mode, expanded: null, compact: mode === "code" });
  setSideOpen(mode !== "debug");
  setSession({ panelOpen: true, panelTab: mode === "debug" ? "debug" : "problems", serviceExpanded: false });
}
export function autoWorkbenchLayout(mode: WorkbenchMode): boolean {
  if (snapshot.locked || snapshot.mode === mode) return false;
  selectWorkbenchLayout(mode);
  return true;
}
export function restoreWorkbenchLayout(): void {
  updateWorkbenchLayout({ ...DEFAULTS, sides: {}, heights: {}, pinned: [] });
  setSideOpen(true);
  setSession({ panelOpen: true, panelTab: "problems", serviceExpanded: false });
}
export function revealWorkbenchPanel(panel: PanelTab): void {
  updateWorkbenchLayout({ compact: false, expanded: snapshot.expanded === panel ? panel : null });
}
export function togglePinnedPanel(panel: PanelTab): void {
  if (!SECONDARY_PANELS.includes(panel)) return;
  updateWorkbenchLayout({ pinned: snapshot.pinned.includes(panel) ? snapshot.pinned.filter(p => p !== panel) : [...snapshot.pinned, panel] });
}
export function panelMaxHeight(panel: PanelTab, viewportHeight: number): number {
  // Service controls need more space in short windows; other output preserves the code area.
  return Math.max(140, Math.round(viewportHeight * (panel === "svc" ? .75 : .65)));
}
export function panelHeight(layout: WorkbenchLayout, panel: PanelTab, viewportHeight: number): number {
  const preferred = layout.heights[panel] ?? (panel === "svc" ? 360 : panel === "debug" ? 260 : 200);
  return Math.max(140, Math.min(preferred, panelMaxHeight(panel, viewportHeight)));
}
