import { useCallback, useEffect, useRef, useState } from "react";
import { closeModel, openModel, renameModel } from "../lib/editorStore";
import { baseName, encodingMarks, readFile, remapPath, type Eol } from "../lib/workspace";
import type { Problem } from "../lib/compile";
import { consumePendingOpen, onOpenFileRequest, type OpenFileRequest } from "../lib/openFileRequest";
import { useFileSave } from "./useFileSave";
import { useJdtOpen } from "./useJdtOpen";
import { useSplitView } from "./useSplitView";
import { recordRecent } from "../lib/recentFiles";
import { rememberClosed } from "../lib/closedTabs";
import { reopenClosed } from "../lib/reopenClosed";
import {
  addTab,
  applyUnifiedEol,
  coversPath,
  pickClosable,
  pinTab,
  renameTabs,
  tabMetaFromDisk,
} from "../lib/tabSession";
import {
  getSession,
  setSession,
  setTree,
  useWorkspaceSelector,
  type TabMeta,
  type Updater,
} from "../lib/workspaceSession";
import { toast } from "../components/ui/toast";
import { trackOperation } from "../lib/operations";
import { workspaceEpoch } from "../lib/workspaceEpoch";
import { friendlyError } from "../lib/friendlyError";
import { navAt, navBack, navForward, type NavPoint } from "../lib/navHistory";
import { captureFileJumpOrigin, recordFileJump } from "../lib/navContext";

/** 标签与文件操作共用打开序号，避免异步读盘把较新的选择顶掉。 */
export function useFileSession() {
  const tabs = useWorkspaceSelector((s) => s.tabs);
  const activePath = useWorkspaceSelector((s) => s.activePath);
  const conflictPath = useWorkspaceSelector((s) => s.conflictPath);
  const closingPath = useWorkspaceSelector((s) => s.closingPath);
  const setTabs = (v: Updater<TabMeta[]>) => setSession({ tabs: v });
  const setActivePath = (v: Updater<string | null>) => setSession({ activePath: v });
  // 「等用户决定」的三态放仓库：切页卸载后必须还在（见 workspaceSession 的注释）
  const setConflictPath = (v: Updater<string | null>) => setSession({ conflictPath: v });
  const setClosingPath = (v: Updater<string | null>) => setSession({ closingPath: v });

  // 点问题行/搜索命中要跳到的位置；null = 没有待跳转。
  const [reveal, setReveal] = useState<{ line: number; column?: number; nonce: number } | null>(null);
  const revealSeq = useRef(0);
  /** 打开 jar 内类：读源码（没有就反编译）、建标签、失败提示都在里面。 */
  const openJdtTab = useJdtOpen(setTabs);
  /**
   * 打开文件的序号。
   *
   * 打开是异步的：连点两条搜索结果时，先发的那次可能后回。没有这道判定的话，
   * 它会 `setActivePath` 把用户最后点的那条顶掉——而定位（`revealSeq`）只对最后一次
   * 生效，于是出现「激活的是 A、该跳的行被丢弃」这种组合。
   */
  const openSeq = useRef(0);

  /**
   * 打开文件。`preview`：文件树单击的预览打开——顶替现有预览标签，不固定。
   * 已经开着的文件再次以非预览方式打开（双击、搜索命中、问题跳转）就把它固定下来。
   *
   * 返回是否真的打开成功了：导航历史只记成功的——记了打不开的文件，
   * 「后退」过去只会再撞一次报错。
   */
  const openFile = useCallback(
    async (path: string, opts?: { preview?: boolean; silent?: boolean }): Promise<boolean> => {
      const existing = getSession().tabs.find((t) => t.path.toLowerCase() === path.toLowerCase());
      if (existing) {
        path=existing.path;
        if (existing.preview && !opts?.preview) setTabs((ts) => pinTab(ts, path));
        // 已有标签是同步命中的，也要占号：它同样是「用户此刻要点的那一个」
        openSeq.current += 1;
        setActivePath(path);
        return true;
      }
      const nonce = ++openSeq.current;
      const root=getSession().root,epoch=workspaceEpoch();
      try {
        const c = opts?.silent ? await readFile(path) : await trackOperation({key:`file.open:${path.toLowerCase()}`,label:`读取 ${baseName(path)}`,scope:path,page:"files",path,phase:"正在读取文件"},()=>readFile(path));
        // 慢读取属于旧工程/旧预览时，不能把它加进当前工作区或顶替最新预览。
        if(epoch!==workspaceEpoch() || root!==getSession().root || opts?.preview && nonce!==openSeq.current) return false;
        path=getSession().tabs.find(t=>t.path.toLowerCase()===path.toLowerCase())?.path??path;
        openModel(path, c);
        const meta = tabMetaFromDisk(path, c);
        // 连点两次时第二次可能已经加过，避免重复标签
        setTabs((ts) => {
          if (ts.some((t) => t.path === path)) return ts;
          const r = addTab(ts, meta, !!opts?.preview);
          if (r.dropped) closeModel(r.dropped);
          return r.tabs;
        });
        // 标签照建（这个文件确实要打开），但激活项只归最后一次点击
        if (nonce === openSeq.current) setActivePath(path);
        recordRecent(getSession().root, path);
        // 从搜索结果打开的文件不在树里，树上那次扫描覆盖不到它，这里补一次，
        // 状态栏的「UTF-8 未登记」才不会只在树里点开时才有。
        void encodingMarks([path])
          .then((found) => epoch === workspaceEpoch() && root === getSession().root &&
            setTree((t) => {
              const next = { ...t.marks };
              if (found.length > 0) next[path] = found[0];
              else delete next[path];
              return { ...t, marks: next };
            }),
          )
          .catch(() => {});
        return true;
      } catch (e) {
        // 会话恢复时静默：上次开着的文件可能已被删/改名，启动就弹一串红字没有意义
        if (!opts?.silent) toast(`无法打开 ${baseName(path)}：${friendlyError(e)}`, "error");
        return false;
      }
    },
    [],
  );
  const split = useSplitView(openFile);

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
      // nonce 提前占号：连点两条命中时，只有最后一次的定位算数
      // （打开是异步的，后点的那个可能先 resolve，旧请求不能把定位抢回去）
      const nonce = ++revealSeq.current;
      const origin = captureFileJumpOrigin();
      void openFileRef.current(req.path).then((ok) => {
        // 打开失败的文件不进导航历史：否则「后退」过去还是打不开，还多一声报错
        if (!ok || nonce !== revealSeq.current) return;
        recordFileJump(origin, { path: req.path, line: req.line ?? 1, column: req.column });
        if (req.line == null) return;
        setReveal({ line: req.line, column: req.column, nonce });
      });
    };
    const off = onOpenFileRequest(handle);
    const pending = consumePendingOpen();
    if (pending) handle(pending);
    return off;
  }, []);

  const { saving, saveFile, saveAsUtf8, reloadFile } = useFileSave(activePath);

  const closeTab = (path: string, confirmed = false) => {
    const tab = tabs.find((t) => t.path === path);
    if (!tab) return;
    if ((tab.dirty || tab.eolChanged) && !confirmed) {
      setClosingPath(path);
      return;
    }
    closeModel(path);
    rememberClosed(path);
    const idx = tabs.findIndex((t) => t.path === path);
    const rest = tabs.filter((t) => t.path !== path);
    setTabs(rest);
    if (activePath === path) setActivePath(rest[Math.min(idx, rest.length - 1)]?.path ?? null);
    if (split.splitPath === path) split.setSplitPath(null);
    if (conflictPath === path) setConflictPath(null);
  };

  const reopenLast = () => reopenClosed(openFile);

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
    if (split.splitPath && coversPath(split.splitPath, oldPath)) split.setSplitPath(remapPath(split.splitPath, oldPath, newPath));
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
    if (split.splitPath && gone(split.splitPath)) split.setSplitPath(null);
    if (conflictPath && gone(conflictPath)) setConflictPath(null);
  };

  /**
   * 打开文件（已在标签里就是切过去）并跳到该行。
   * nonce 提前占号：连点同一个文件的两条问题时，只有最后一次的定位算数
   * （打开是异步的，后点的那个可能先 resolve，旧请求不能把定位抢回去）。
   * 打开失败的不进导航历史也不定位：否则「后退」过去还是打不开，还多一声报错。
   *
   * `push=false` 是「后退 / 前进」在用的：那两个动作本身就是回到历史里的某个点，
   * 再记一笔会让前进栈立刻被自己清掉（退两步就再也前进不回去）。
   */
  const openAt = (path: string, line: number, push = true, column?: number): Promise<void> => {
    const origin = push ? captureFileJumpOrigin() : null;
    const nonce = ++revealSeq.current;
    // 跳转目标的盘符/大小写可能与标签里的不一致：已有同一文件的标签就复用它，免得开出重复标签
    return openFile(tabs.find((t) => t.path.toLowerCase() === path.toLowerCase())?.path ?? path).then((ok) => {
      if (!ok || nonce !== revealSeq.current) return;
      if (push) recordFileJump(origin, { path, line, column });
      setReveal({ line, column, nonce });
    });
  };

  const openProblem = (p: Problem) => void openAt(p.file, p.line);

  /** 打开 jar 内的类（jdt.ls 给出的 `jdt://` 地址）为只读标签页。 */
  const openJdt = async (uri: string, line: number, push = true) => {
    const origin = push ? captureFileJumpOrigin() : null;
    // 与 openFile 同一个道理：读源码是异步的，只有最后一次打开有权激活
    const nonce = ++revealSeq.current,openNonce=++openSeq.current;
    if (!(await openJdtTab(uri))) return;
    if (nonce !== revealSeq.current || openNonce !== openSeq.current) return;
    if (push) recordFileJump(origin, { path: uri, line, jdt: true });
    setActivePath(uri);
    setReveal({ line, nonce });
  };

  /** 回到历史里的某个点。不要走 openAt 的默认参数——那会把它重新记成新历史。 */
  const goToNav = (p: NavPoint) => {
    if (p.jdt) void openJdt(p.path, p.line, false);
    else void openAt(p.path, p.line, false, p.column);
  };

  const goBack = () => {
    const p = navBack();
    if (p) goToNav(p);
  };

  const goForward = () => {
    const p = navForward();
    if (p) goToNav(p);
  };

  /** 批量关闭（关闭其他 / 右侧 / 已保存）：未保存的保留，返回保留个数供提示。 */
  const closeMany = (want: (t: TabMeta, index: number) => boolean): number => {
    const { close, kept } = pickClosable(tabs, want);
    if (close.length === 0) return kept;
    close.forEach((p) => closeModel(p));
    close.forEach(rememberClosed);
    const rest = tabs.filter((t) => !close.includes(t.path));
    setTabs(rest);
    if (activePath && close.includes(activePath)) setActivePath(rest[rest.length - 1]?.path ?? null);
    if (split.splitPath && close.includes(split.splitPath)) split.setSplitPath(null);
    if (conflictPath && close.includes(conflictPath)) setConflictPath(null);
    return kept;
  };

  const pin = (path: string) => setTabs((ts) => pinTab(ts, path));

  const unifyEol = (path: string, eol: Eol) => setTabs((ts) => applyUnifiedEol(ts, path, eol));

  return {
    conflictPath,
    closingPath,
    splitPath: split.splitPath,
    saving,
    reveal,
    openFile,
    saveFile,
    saveAsUtf8,
    reloadFile,
    closeTab,
    closeMany,
    openSplit: split.openSplit,
    closeSplit: split.closeSplit,
    reopenLast,
    pin,
    handleRenamed,
    handleDeleted,
    openProblem,
    openAt,
    openJdt,
    goBack,
    goForward,
    goToHistory: (index: number) => { const point = navAt(index); if (point) goToNav(point); },
    unifyEol,
    cancelClose: () => setClosingPath(null),
  };
}
