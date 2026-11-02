import { useEffect, useRef } from "react";
import { getSession, setSession, type TabMeta } from "../lib/workspaceSession";
import { readTabSnapshot, saveTabSnapshot } from "../lib/tabPersistence";
import { mruNeighbor, pruneMru, touchMru } from "../lib/tabMru";
import { getKeymap, isReopenTabKey } from "../lib/keymap";
import type { useFileSession } from "./useFileSession";

/**
 * 重启后恢复上次开着的标签 / 激活项 / 分屏。
 *
 * 每个工作区在一次运行里只恢复一次：用户关光标签后切页再回来，
 * 不该又从快照里把文件全打开。快照按 root 分组，见 `lib/tabPersistence`。
 */
const restoredRoots = new Set<string>();

export function useTabRestore(
  root: string | null | undefined,
  openFile: (path: string, opts?: { preview?: boolean; silent?: boolean }) => Promise<boolean>,
): void {
  const openRef = useRef(openFile);
  openRef.current = openFile;
  useEffect(() => {
    if (!root) return;
    const key = root.toLowerCase();
    if (restoredRoots.has(key)) return;
    restoredRoots.add(key);
    // 这次运行里已经打开过文件（比如从搜索页跳进来）就不覆盖用户的现场
    if (getSession().tabs.length > 0) return;
    const snap = readTabSnapshot(root);
    if (!snap) return;
    let cancelled = false;
    void (async () => {
      const opened: string[] = [];
      for (const path of snap.tabs) {
        if (cancelled) return;
        if (await openRef.current(path, { silent: true })) opened.push(path);
      }
      if (cancelled || opened.length === 0) return;
      const match = (want: string | null) =>
        want ? opened.find((p) => p.toLowerCase() === want.toLowerCase()) : undefined;
      const active = match(snap.activePath);
      if (active) setSession({ activePath: active });
      const split = match(snap.splitPath);
      if (split) setSession({ splitPath: split });
    })();
    return () => {
      cancelled = true;
    };
  }, [root]);
}

/** 把当前标签 / 激活项 / 分屏防抖写回快照（只存路径）。 */
export function useTabPersistence(
  root: string | null | undefined,
  tabs: TabMeta[],
  activePath: string | null,
  splitPath: string | null,
): void {
  useEffect(() => {
    if (!root) return;
    const t = window.setTimeout(() => {
      saveTabSnapshot(root, { tabs: tabs.map((x) => x.path), activePath, splitPath });
    }, 400);
    return () => window.clearTimeout(t);
  }, [root, tabs, activePath, splitPath]);
}

/**
 * 标签相关快捷键：Ctrl+Shift+T 重开、Ctrl+Tab / Ctrl+Shift+Tab 按 MRU 切换。
 *
 * 挂在 window 捕获阶段：焦点通常在 Monaco 的 textarea 里，不捕获就收不到。
 * 只让位给真正的模态框和输入框（编辑器自己的 textarea 除外）。
 */
export function useTabSessionKeys(
  tabs: TabMeta[],
  activePath: string | null,
  session: Pick<ReturnType<typeof useFileSession>, "reopenLast">,
): void {
  const live = useRef({ tabs, activePath, session });
  live.current = { tabs, activePath, session };

  useEffect(() => {
    touchMru(activePath);
    pruneMru(tabs.map((t) => t.path));
  }, [tabs, activePath]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !e.ctrlKey || e.metaKey) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]:not([data-exiting]), dialog[open]')) return;
      // 文件页被工具页盖住时，Ctrl+Tab 不该去动隐藏的标签
      if (document.querySelector("#wb-code-surface[hidden]")) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      const formField = target && !target.closest(".monaco-editor") && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      if (formField) return;

      // Eclipse 方案的恢复键是 Ctrl+Alt+T（Ctrl+Shift+T 在那边是转到类型），所以这里不能先挡 Alt
      if (isReopenTabKey(e, getKeymap())) {
        if (e.repeat) return;
        e.preventDefault();
        e.stopPropagation();
        void live.current.session.reopenLast();
        return;
      }
      if (e.altKey) return;
      if (e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        const { tabs: open, activePath: current } = live.current;
        const next = mruNeighbor(current, open.map((t) => t.path), e.shiftKey ? -1 : 1);
        if (next) setSession({ activePath: next });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}
