import { useEffect, useRef } from "react";
import { getSession, setSession, useWorkspaceSelector, type TabMeta } from "../lib/workspaceSession";
import { readTabSnapshot, saveTabSnapshot } from "../lib/tabPersistence";
import { mruNeighbor, pruneMru, touchMru } from "../lib/tabMru";
import { getKeymap, isReopenTabKey, tabKeyAction } from "../lib/keymap";
import { activeOfGroup } from "../lib/editorGroups";
import { workspaceEpoch } from "../lib/workspaceEpoch";
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
    // 恢复期间可能被切工程 / 换工作区打断：旧快照的路径属于旧工程，追加进新会话
    // 会凭空多出打不开的标签，而且把新工程自己的恢复堵死（tabs 非空 + key 已置位）。
    const epoch = workspaceEpoch();
    let cancelled = false, done = false;
    void (async () => {
      const opened: string[] = [];
      const priority = [...new Set([snap.activePath, snap.splitPath].filter((path): path is string => !!path))];
      for (const path of priority) {
        if (cancelled) return;
        if (await openRef.current(path, { silent: true })) opened.push(path);
      }
      if (cancelled || opened.length === 0) return;
      // 恢复中途换了工程：epoch 由 `switchWorkspace` 推进，旧快照的路径不能落进新会话
      if (workspaceEpoch() !== epoch) return;
      const shells: TabMeta[] = snap.tabs.filter(path => !opened.includes(path)).map(path => ({
        path, name: path.split(/[\\/]/).pop() ?? path, deferred: true,
        encoding: "UTF-8", hasBom: false, eol: "LF", mtimeMs: 0, dirty: false,
        eolChanged: false, readOnly: false, readOnlyReason: null, lines: 0,
      }));
      setSession({ tabs: tabs => [...tabs, ...shells] });
      done = true;
      const match = (want: string | null) =>
        want ? opened.find((p) => p.toLowerCase() === want.toLowerCase()) : undefined;
      const active = match(snap.activePath);
      if (active) setSession({ activePath: active });
      const split = match(snap.splitPath);
      if (split) setSession({ splitPath: split });
    })();
    return () => {
      cancelled = true;
      // 没走完就被卸载（切页 / 换工程）：放开标记，下次回来还能接着恢复。
      // 一直按「已恢复」记着的话，这一趟运行里剩下的标签永远不会出现。
      if (!done) restoredRoots.delete(key);
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
  const latest = useRef({ root, tabs, activePath, splitPath });
  latest.current = { root, tabs, activePath, splitPath };
  useEffect(() => {
    if (!root) return;
    const t = window.setTimeout(() => {
      saveTabSnapshot(root, { tabs: tabs.map((x) => x.path), activePath, splitPath });
    }, 400);
    return () => window.clearTimeout(t);
  }, [root, tabs, activePath, splitPath]);
  // 卸载时补写一次。文件页是按 tab 切的，切走那一刻现场必须落盘——否则
  // 「开/关标签后立刻切页再退出」会丢掉最后 400ms 内的改动，重启后标签少几条。
  useEffect(() => () => {
    const v = latest.current;
    if (v.root) saveTabSnapshot(v.root, { tabs: v.tabs.map((x) => x.path), activePath: v.activePath, splitPath: v.splitPath });
  }, []);
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
  session: Pick<ReturnType<typeof useFileSession>, "reopenLast" | "selectTab">,
): void {
  const groups = useWorkspaceSelector(s => s.editorGroups);
  const live = useRef({ tabs, activePath, session });
  live.current = { tabs, activePath, session };

  useEffect(() => {
    touchMru(groups ? activeOfGroup(groups, groups.focused) : activePath, groups?.focused);
    pruneMru(tabs.map((t) => t.path), groups?.focused);
  }, [tabs, activePath, groups]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.isComposing) return;
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
      const action = tabKeyAction(e);
      if (action) {
        const groupState = getSession().editorGroups;
        if (action === "left" || action === "right") {
          if (!groupState?.[action].length) return;
          e.preventDefault(); e.stopPropagation();
          setSession({ editorGroups: { ...groupState, focused: action } });
          const path = activeOfGroup(groupState, action); if (path) live.current.session.selectTab(path);
          requestAnimationFrame(() => document.getElementById(`wb-editor-${action}-surface`)?.querySelector<HTMLElement>('.monaco-editor textarea')?.focus());
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        const { tabs: open, activePath: current } = live.current;
        const focused = groupState?.focused, paths = focused ? groupState[focused] : open.map((t) => t.path);
        const next = mruNeighbor(focused ? activeOfGroup(groupState!, focused) : current, paths, action === "previous" ? -1 : 1, focused);
        if (next) live.current.session.selectTab(next);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}
