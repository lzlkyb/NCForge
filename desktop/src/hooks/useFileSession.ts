import { useCallback, useEffect, useRef, useState } from "react";
import { closeModel, openModel, renameModel } from "../lib/editorStore";
import { baseName, encodingMarks, readFile, remapPath, type Eol } from "../lib/workspace";
import type { Problem } from "../lib/compile";
import { consumePendingOpen, onOpenFileRequest, type OpenFileRequest } from "../lib/openFileRequest";
import { loadJdtSource } from "../lib/lang";
import { useFileSave } from "./useFileSave";
import { recordRecent } from "../lib/recentFiles";
import {
  addTab,
  applyUnifiedEol,
  coversPath,
  pickClosable,
  pinTab,
  renameTabs,
  tabMetaFromDisk,
  tabMetaFromJdt,
} from "../lib/tabSession";
import {
  getSession,
  setSession,
  setTree,
  useWorkspaceSession,
  type TabMeta,
  type Updater,
} from "../lib/workspaceSession";
import { toast } from "../components/ui/toast";

/**
 * 标签页的生命周期：打开、保存、异地冲突、关闭、改名跟随、删除跟随。
 *
 * 为什么单独一个 hook：这几件事共用同一批互相牵扯的状态
 * （标签数组、激活项、冲突项、待关闭项、跳转 nonce），拆开就会各自持有一份陈旧副本。
 * 界面只负责把回调接到按钮上。
 */
export function useFileSession() {
  const { tabs, activePath, conflictPath, closingPath } = useWorkspaceSession();
  const setTabs = (v: Updater<TabMeta[]>) => setSession({ tabs: v });
  const setActivePath = (v: Updater<string | null>) => setSession({ activePath: v });
  // 「等用户决定」的三态放仓库：切页卸载后必须还在（见 workspaceSession 的注释）
  const setConflictPath = (v: Updater<string | null>) => setSession({ conflictPath: v });
  const setClosingPath = (v: Updater<string | null>) => setSession({ closingPath: v });

  // 点问题行/搜索命中要跳到的位置；null = 没有待跳转。
  const [reveal, setReveal] = useState<{ line: number; column?: number; nonce: number } | null>(null);
  const revealSeq = useRef(0);

  /**
   * 打开文件。`preview`：文件树单击的预览打开——顶替现有预览标签，不固定。
   * 已经开着的文件再次以非预览方式打开（双击、搜索命中、问题跳转）就把它固定下来。
   */
  const openFile = useCallback(
    async (path: string, opts?: { preview?: boolean }) => {
      const existing = tabs.find((t) => t.path === path);
      if (existing) {
        if (existing.preview && !opts?.preview) setTabs((ts) => pinTab(ts, path));
        setActivePath(path);
        return;
      }
      try {
        const c = await readFile(path);
        openModel(path, c);
        const meta = tabMetaFromDisk(path, c);
        // 连点两次时第二次可能已经加过，避免重复标签
        setTabs((ts) => {
          if (ts.some((t) => t.path === path)) return ts;
          const r = addTab(ts, meta, !!opts?.preview);
          if (r.dropped) closeModel(r.dropped);
          return r.tabs;
        });
        setActivePath(path);
        recordRecent(getSession().root, path);
        // 从搜索结果打开的文件不在树里，树上那次扫描覆盖不到它，这里补一次，
        // 状态栏的「UTF-8 未登记」才不会只在树里点开时才有。
        void encodingMarks([path])
          .then((found) =>
            setTree((t) => {
              const next = { ...t.marks };
              if (found.length > 0) next[path] = found[0];
              else delete next[path];
              return { ...t, marks: next };
            }),
          )
          .catch(() => {});
      } catch (e) {
        toast(`无法打开 ${baseName(path)}：${e}`, "error");
      }
    },
    [tabs],
  );

  // 别的页面（搜索页）请求「打开这个文件的第 N 行」：
  // 订阅 + 取走挂载前攒下的那一条。取 pending 是必须的——切页时本组件才挂载，
  // 订阅必然晚于事件，只订阅会漏掉第一次点击。
  //
  // 回调存 ref、effect 只跑一次：`openFile` 依赖 tabs，每次开/关标签都会换身份，
  // 直接挂依赖等于每开一个文件就整体退订重订一次。
  const openFileRef = useRef(openFile);
  openFileRef.current = openFile;
  useEffect(() => {
    const handle = (req: OpenFileRequest) => {
      void openFileRef.current(req.path).then(() => {
        if (req.line == null) return;
        revealSeq.current += 1;
        setReveal({ line: req.line, column: req.column, nonce: revealSeq.current });
      });
    };
    const off = onOpenFileRequest(handle);
    const pending = consumePendingOpen();
    if (pending) handle(pending);
    return off;
  }, []);

  const { saving, saveFile, saveAsUtf8, reloadFile } = useFileSave(tabs, activePath);

  const closeTab = (path: string, confirmed = false) => {
    const tab = tabs.find((t) => t.path === path);
    if (!tab) return;
    if ((tab.dirty || tab.eolChanged) && !confirmed) {
      setClosingPath(path);
      return;
    }
    closeModel(path);
    const idx = tabs.findIndex((t) => t.path === path);
    const rest = tabs.filter((t) => t.path !== path);
    setTabs(rest);
    if (activePath === path) setActivePath(rest[Math.min(idx, rest.length - 1)]?.path ?? null);
    if (conflictPath === path) setConflictPath(null);
  };

  /**
   * 文件或目录改名：把卡片、model、激活项一并挪到新路径。
   *
   * 不先拦未保存的文件——内容在 model 里，跟着搬到新路径后仍然是同一份改动，
   * 保存时 mtime 也没变，不会误判成冲突。
   */
  const handleRenamed = (oldPath: string, newPath: string) => {
    const affected = tabs.filter((t) => coversPath(t.path, oldPath));
    if (affected.length === 0) return;
    affected.forEach((t) => renameModel(t.path, remapPath(t.path, oldPath, newPath)));
    setTabs((ts) => renameTabs(ts, oldPath, newPath));
    if (activePath && coversPath(activePath, oldPath)) setActivePath(remapPath(activePath, oldPath, newPath));
    if (conflictPath && coversPath(conflictPath, oldPath)) setConflictPath(remapPath(conflictPath, oldPath, newPath));
  };

  /** 删除：直接用后端结果关标签，不再问「未保存要不要保存」——文件已经没了。 */
  const handleDeleted = (paths: string[]) => {
    const gone = (p: string) => paths.some((d) => coversPath(p, d));
    const rest = tabs.filter((t) => !gone(t.path));
    if (rest.length !== tabs.length) {
      tabs.filter((t) => gone(t.path)).forEach((t) => closeModel(t.path));
      setTabs(rest);
    }
    if (activePath && gone(activePath)) setActivePath(rest[0]?.path ?? null);
    if (conflictPath && gone(conflictPath)) setConflictPath(null);
  };

  /**
   * 打开文件（已在标签里就是切过去）并跳到该行。
   * nonce 每次自增：连点同一个文件的两条问题时，只有它变才会重新定位。
   */
  const openAt = (path: string, line: number) =>
    // 跳转目标的盘符/大小写可能与标签里的不一致：已有同一文件的标签就复用它，免得开出重复标签
    openFile(tabs.find((t) => t.path.toLowerCase() === path.toLowerCase())?.path ?? path).then(() =>
      setReveal({ line, nonce: ++revealSeq.current }),
    );

  const openProblem = (p: Problem) => void openAt(p.file, p.line);

  /** 打开 jar 内的类（jdt.ls 给出的 `jdt://` 地址）为只读标签页。 */
  const openJdt = async (uri: string, line: number) => {
    if (!tabs.some((t) => t.path === uri)) {
      try {
        const meta = tabMetaFromJdt(uri, await loadJdtSource(uri));
        setTabs((ts) => (ts.some((t) => t.path === uri) ? ts : [...ts, meta]));
      } catch (e) {
        toast(`无法读取类源码：${e}`, "error");
        return;
      }
    }
    setActivePath(uri);
    setReveal({ line, nonce: ++revealSeq.current });
  };

  /** 批量关闭（关闭其他 / 右侧 / 已保存）：未保存的保留，返回保留个数供提示。 */
  const closeMany = (want: (t: TabMeta, index: number) => boolean): number => {
    const { close, kept } = pickClosable(tabs, want);
    if (close.length === 0) return kept;
    close.forEach((p) => closeModel(p));
    const rest = tabs.filter((t) => !close.includes(t.path));
    setTabs(rest);
    if (activePath && close.includes(activePath)) setActivePath(rest[rest.length - 1]?.path ?? null);
    if (conflictPath && close.includes(conflictPath)) setConflictPath(null);
    return kept;
  };

  const pin = (path: string) => setTabs((ts) => pinTab(ts, path));

  const unifyEol = (path: string, eol: Eol) => setTabs((ts) => applyUnifiedEol(ts, path, eol));

  return {
    conflictPath,
    closingPath,
    saving,
    reveal,
    openFile,
    saveFile,
    saveAsUtf8,
    reloadFile,
    closeTab,
    closeMany,
    pin,
    handleRenamed,
    handleDeleted,
    openProblem,
    openAt,
    openJdt,
    unifyEol,
    cancelClose: () => setClosingPath(null),
  };
}
