import { useCallback, useEffect, useRef, useState } from "react";
import {
  closeModel,
  getText,
  markSaved,
  openModel,
  renameModel,
  replaceContent,
} from "../lib/editorStore";
import {
  baseName,
  encodingMarks,
  isConflictError,
  isUnencodableError,
  cleanError,
  readFile,
  remapPath,
  writeFile,
  type Eol,
  type TextEncoding,
} from "../lib/workspace";
import type { Problem } from "../lib/compile";
import { consumePendingOpen, onOpenFileRequest, type OpenFileRequest } from "../lib/openFileRequest";
import { loadJdtSource } from "../lib/lang";
import {
  applySaved,
  applyUnifiedEol,
  coversPath,
  renameTabs,
  tabMetaFromDisk,
  tabMetaFromJdt,
} from "../lib/tabSession";
import {
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
  const setEncodingIssue = (v: Updater<{ path: string; message: string } | null>) =>
    setSession({ encodingIssue: v });

  const [saving, setSaving] = useState(false);
  /**
   * 进行态的同步副本。`saving` 是渲染期才更新的，两个 Ctrl+S 落在同一个 tick 时
   * 双方都读到 false，会写两次盘（第二次还会带着第一次的旧 mtime 触发冲突误报）。
   */
  const savingRef = useRef(false);
  // 点问题行/搜索命中要跳到的位置；null = 没有待跳转。
  const [reveal, setReveal] = useState<{ line: number; column?: number; nonce: number } | null>(null);
  const revealSeq = useRef(0);

  const openFile = useCallback(
    async (path: string) => {
      if (tabs.some((t) => t.path === path)) {
        setActivePath(path);
        return;
      }
      try {
        const c = await readFile(path);
        openModel(path, c);
        const meta = tabMetaFromDisk(path, c);
        // 连点两次时第二次可能已经加过，避免重复标签
        setTabs((ts) => (ts.some((t) => t.path === path) ? ts : [...ts, meta]));
        setActivePath(path);
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

  /**
   * 保存。`encodingOverride` 用于「转成 UTF-8 保存」——GBK 文件写进了它表示不了的
   * 字符时，后端会拒（`UNENCODABLE`），这条路径把编码换掉再存一次。
   */
  const saveFile = async (path: string, force = false, encodingOverride?: TextEncoding) => {
    const tab = tabs.find((t) => t.path === path);
    if (!tab || tab.readOnly || savingRef.current) return;
    const text = getText(path);
    if (text === undefined) return;
    const encoding = encodingOverride ?? tab.encoding;
    // 转 UTF-8 时不写 BOM：BOM 是「原来是 UTF-8 带 BOM」这个事实的延续，
    // 转换后的文件不该凭空多出三个字节。
    const hasBom = encodingOverride === "UTF-8" ? false : tab.hasBom;
    savingRef.current = true;
    setSaving(true);
    try {
      const mtime = await writeFile({
        path,
        text,
        encoding,
        hasBom,
        eol: tab.eol,
        expectedMtimeMs: force ? null : tab.mtimeMs,
      });
      markSaved(path);
      setTabs((ts) =>
        applySaved(ts, path, { mtimeMs: mtime, encoding, hasBom, converted: !!encodingOverride }),
      );
      setConflictPath(null);
      setEncodingIssue(null);
      toast(encodingOverride ? `已转为 UTF-8 并保存 ${tab.name}` : `已保存 ${tab.name}`, "success");
    } catch (e) {
      if (isConflictError(e)) setConflictPath(path);
      else if (isUnencodableError(e)) setEncodingIssue({ path, message: cleanError(e) });
      else toast(`保存失败：${cleanError(e)}`, "error");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  /** 「转成 UTF-8 保存」按钮。 */
  const saveAsUtf8 = async (path: string) => {
    setEncodingIssue(null);
    await saveFile(path, false, "UTF-8");
  };

  /**
   * 全局 Ctrl+S。
   *
   * 编辑器只在自己聚焦时处理快捷键，而焦点常在文件树、标签条、底部面板上——
   * 按 Ctrl+S 静默无反应，可编译前的提示语恰恰在教用户「请先保存（Ctrl+S）」。
   * 本 hook 只在文件页挂载，所以不会在别的页面劫持这个键。
   */
  const saveRef = useRef(saveFile);
  saveRef.current = saveFile;
  const activeRef = useRef(activePath);
  activeRef.current = activePath;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.shiftKey || e.key.toLowerCase() !== "s") return;
      const path = activeRef.current;
      if (!path) return;
      e.preventDefault();
      void saveRef.current(path);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** 异地修改后选「重新加载」：丢弃编辑器里的修改，采用磁盘版本。 */
  const reloadFile = async (path: string) => {
    try {
      const c = await readFile(path);
      replaceContent(path, c);
      setTabs((ts) =>
        ts.map((t) =>
          t.path === path
            ? { ...t, encoding: c.encoding, hasBom: c.hasBom, eol: c.eol, mtimeMs: c.mtimeMs, dirty: false, eolChanged: false }
            : t,
        ),
      );
      setConflictPath(null);
    } catch (e) {
      toast(`重新加载失败：${e}`, "error");
    }
  };

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
    handleRenamed,
    handleDeleted,
    openProblem,
    openAt,
    openJdt,
    unifyEol,
    cancelClose: () => setClosingPath(null),
  };
}
