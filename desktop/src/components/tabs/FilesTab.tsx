import { useCallback, useEffect, useRef, useState } from "react";
import "../../workspace.css";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { EmptyState } from "../ui/EmptyState";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";
import { toast } from "../ui/toast";
import { EditorPane } from "../workspace/EditorPane";
import { FileTree, type FileTreeHandle } from "../workspace/FileTree";
import { BottomPanel } from "../workspace/BottomPanel";
import {
  closeModel,
  getText,
  markSaved,
  openModel,
  renameModel,
  replaceContent,
} from "../../lib/editorStore";
import {
  baseName,
  encodingMarks,
  getWorkspace,
  isConflictError,
  languageOf,
  readFile,
  remapPath,
  setWorkspace,
  writeFile,
  type Eol,
} from "../../lib/workspace";
import { compileModule, onCompileLog, type Problem } from "../../lib/compile";
import { consumePendingOpen, onOpenFileRequest, type OpenFileRequest } from "../../lib/openFileRequest";
import {
  setSession,
  setTree,
  useWorkspaceSession,
  type TabMeta,
  type Updater,
} from "../../lib/workspaceSession";

/**
 * 超过这个行数就提示「语义补全不可用」。
 *
 * 阈值来自实测：`VoucherBO.java`（6433 行）在 jdt.ls 下补全恒为 0；
 * 几千行的文件打开也明显变慢。2000 行是「还正常」与「开始降级」的分界。
 */
const LARGE_FILE_LINES = 2000;

export function FilesTab() {
  const [rootInput, setRootInput] = useState("");
  const [editingRoot, setEditingRoot] = useState(false);
  // 标签、激活项、面板与编译结果都存在模块级仓库里：切页卸载再回来不该丢。
  const {
    root,
    tabs,
    activePath,
    panelOpen,
    panelTab,
    compiling,
    compileResult,
    compileLog,
    tree,
    largeHintDismissed,
  } = useWorkspaceSession();
  const setRoot = (v: Updater<string | null | undefined>) => setSession({ root: v });
  const setTabs = (v: Updater<TabMeta[]>) => setSession({ tabs: v });
  const setActivePath = (v: Updater<string | null>) => setSession({ activePath: v });
  const setPanelOpen = (v: Updater<boolean>) => setSession({ panelOpen: v });
  const setPanelTab = (v: Updater<typeof panelTab>) => setSession({ panelTab: v });
  const setCompiling = (v: Updater<boolean>) => setSession({ compiling: v });
  const setCompileResult = (v: Updater<typeof compileResult>) => setSession({ compileResult: v });
  const setCompileLog = (v: Updater<string[]>) => setSession({ compileLog: v });

  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [conflictPath, setConflictPath] = useState<string | null>(null);
  const [closingPath, setClosingPath] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // 点问题行要跳到的位置；null = 没有待跳转。
  const [reveal, setReveal] = useState<{ line: number; nonce: number } | null>(null);
  const revealSeq = useRef(0);
  // 标题栏的「新建文件 / 新建文件夹」按钮：交给文件树，由它决定建在哪个目录下
  const treeRef = useRef<FileTreeHandle>(null);

  useEffect(() => {
    getWorkspace()
      .then((r) => setRoot(r))
      .catch(() => setRoot(null));
  }, []);

  // 编译过程的逐行进度（首次建类索引时较久，靠它让界面有反馈）。
  // 切页期间这个订阅会断，期间的日志行收不到，但最终结果写回仓库，回来仍然可见。
  useEffect(() => {
    let off: (() => void) | undefined;
    void onCompileLog((line) => setCompileLog((l) => [...l, line])).then((f) => (off = f));
    return () => off?.();
  }, []);

  const active = tabs.find((t) => t.path === activePath) ?? null;

  const applyRoot = async (path: string) => {
    try {
      const shown = await setWorkspace(path);
      // 换目录后旧标签不再属于当前工作区：全部关掉（调用方已在有未保存修改时警告）
      tabs.forEach((t) => closeModel(t.path));
      setTabs([]);
      setActivePath(null);
      // 编译结果和路径都指向旧工程，留着会让人误读成新工程的问题列表。
      // 这几项现在活在模块级仓库里，不重置就会跨工作区残留。
      setCompileResult(null);
      setCompileLog([]);
      setRoot(shown);
      setEditingRoot(false);
    } catch (e) {
      toast(`无法打开目录：${e}`, "error");
    }
  };

  const openFile = useCallback(
    async (path: string) => {
      if (tabs.some((t) => t.path === path)) {
        setActivePath(path);
        return;
      }
      try {
        const c = await readFile(path);
        openModel(path, c);
        const reason = !c.lossless ? "lossy" : c.eol === "MIXED" ? "mixed" : null;
        const meta: TabMeta = {
          path,
          name: baseName(path),
          encoding: c.encoding,
          hasBom: c.hasBom,
          eol: c.eol,
          mtimeMs: c.mtimeMs,
          dirty: false,
          eolChanged: false,
          readOnly: reason !== null,
          readOnlyReason: reason,
          lines: c.text.split("\n").length,
        };
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
  useEffect(() => {
    const handle = (req: OpenFileRequest) => {
      void openFile(req.path).then(() => {
        if (req.line == null) return;
        revealSeq.current += 1;
        setReveal({ line: req.line, nonce: revealSeq.current });
      });
    };
    const off = onOpenFileRequest(handle);
    const pending = consumePendingOpen();
    if (pending) handle(pending);
    return off;
  }, [openFile]);

  const saveFile = async (path: string, force = false) => {
    const tab = tabs.find((t) => t.path === path);
    if (!tab || tab.readOnly || saving) return;
    const text = getText(path);
    if (text === undefined) return;
    setSaving(true);
    try {
      const mtime = await writeFile({
        path,
        text,
        encoding: tab.encoding,
        hasBom: tab.hasBom,
        eol: tab.eol,
        expectedMtimeMs: force ? null : tab.mtimeMs,
      });
      markSaved(path);
      setTabs((ts) => ts.map((t) => (t.path === path ? { ...t, mtimeMs: mtime, eolChanged: false } : t)));
      setConflictPath(null);
      toast(`已保存 ${tab.name}`, "success");
    } catch (e) {
      if (isConflictError(e)) setConflictPath(path);
      else toast(`保存失败：${e}`, "error");
    } finally {
      setSaving(false);
    }
  };

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

  /** 该路径或它下面的某个文件（目录改名/删除时）是否受影响。 */
  const covers = (path: string, base: string) => {
    const p = path.toLowerCase();
    const b = base.toLowerCase();
    return p === b || p.startsWith(`${b}\\`);
  };

  /**
   * 文件或目录改名：把卡片、model、激活项一并挪到新路径。
   *
   * 不先拦未保存的文件——内容在 model 里，跟着搬到新路径后仍然是同一份改动，
   * 保存时 mtime 也没变，不会误判成冲突。
   */
  const handleRenamed = (oldPath: string, newPath: string) => {
    const affected = tabs.filter((t) => covers(t.path, oldPath));
    if (affected.length === 0) return;
    affected.forEach((t) => renameModel(t.path, remapPath(t.path, oldPath, newPath)));
    setTabs((ts) =>
      ts.map((t) => {
        const next = remapPath(t.path, oldPath, newPath);
        return next === t.path ? t : { ...t, path: next, name: baseName(next) };
      }),
    );
    if (activePath && covers(activePath, oldPath)) setActivePath(remapPath(activePath, oldPath, newPath));
    if (conflictPath && covers(conflictPath, oldPath)) setConflictPath(remapPath(conflictPath, oldPath, newPath));
  };

  /** 删除：直接用后端结果关标签，不再问「未保存要不要保存」——文件已经没了。 */
  const handleDeleted = (paths: string[]) => {
    const gone = (p: string) => paths.some((d) => covers(p, d));
    const rest = tabs.filter((t) => !gone(t.path));
    if (rest.length !== tabs.length) {
      tabs.filter((t) => gone(t.path)).forEach((t) => closeModel(t.path));
      setTabs(rest);
    }
    if (activePath && gone(activePath)) setActivePath(rest[0]?.path ?? null);
    if (conflictPath && gone(conflictPath)) setConflictPath(null);
  };

  /** 编译当前文件所在的模块；有未保存的文件先提醒，因为 ecj 读的是磁盘上的内容。 */
  const compileActive = async () => {
    if (!activePath || compiling) return;
    if (tabs.some((t) => t.dirty || t.eolChanged)) {
      toast("有未保存的文件，编译读取的是磁盘版本，请先保存（Ctrl+S）", "warning");
    }
    setPanelOpen(true);
    setPanelTab("build");
    setCompiling(true);
    setCompileResult(null);
    setCompileLog([]);
    try {
      const r = await compileModule(activePath);
      setCompileResult(r);
      setPanelTab(r.errorCount > 0 ? "problems" : "build");
    } catch (e) {
      setCompileLog((l) => [...l, `编译失败：${e}`]);
      toast(`编译失败：${e}`, "error");
    } finally {
      setCompiling(false);
    }
  };

  const openProblem = (p: Problem) => {
    // 先打开文件（已在标签里就是切过去），再让编辑器跳到该行。
    // nonce 每次自增：连点同一个文件的两条问题时，只有它变才会重新定位。
    void openFile(p.file).then(() => setReveal({ line: p.line, nonce: ++revealSeq.current }));
  };

  const unifyEol = (path: string, eol: Eol) =>
    setTabs((ts) =>
      ts.map((t) => (t.path === path ? { ...t, eol, eolChanged: true, readOnly: false, readOnlyReason: null } : t)),
    );

  if (root === undefined) return null;

  // 尚未选择工作区：明确引导，不让用户盲猜
  if (root === null) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState
          icon="folder"
          description="还没有打开工程目录。输入 NC 二开工程的根目录（如 newar 所在的路径）。"
          className="w-[420px] py-10"
          action={
            <div className="flex w-[360px] gap-2">
              <Input
                value={rootInput}
                placeholder="C:\work\aier\newar"
                onChange={(e) => setRootInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && rootInput.trim() && void applyRoot(rootInput)}
              />
              <Button disabled={!rootInput.trim()} onClick={() => void applyRoot(rootInput)}>
                打开
              </Button>
            </div>
          }
        />
      </div>
    );
  }

  const hasUnsaved = tabs.some((t) => t.dirty || t.eolChanged);
  /** 当前文件在树上被标了 UTF-8! 时，状态栏也说一句。 */
  const activeMark = active ? tree.marks[active.path] : undefined;
  const showLargeHint =
    active !== null && active.lines > LARGE_FILE_LINES && !largeHintDismissed.includes(active.path);
  /** 大文件降级：提示条可以关掉，但编辑器里的降级一直有效。 */
  const heavyFile = active !== null && active.lines > LARGE_FILE_LINES;

  return (
    <div className="wb-root">
      <section className="wb-tree">
        <div className="wb-pane-title">
          <span title={root}>资源管理器 · {baseName(root).toUpperCase()}</span>
          <div className="wb-pane-acts">
            <button
              type="button"
              className="wb-icon-btn"
              title="新建文件（在当前选中的目录下）"
              aria-label="新建文件"
              onClick={() => treeRef.current?.startCreate("file")}
            >
              <Icon name="filePlus" size={14} />
            </button>
            <button
              type="button"
              className="wb-icon-btn"
              title="新建文件夹（在当前选中的目录下）"
              aria-label="新建文件夹"
              onClick={() => treeRef.current?.startCreate("dir")}
            >
              <Icon name="folderPlus" size={14} />
            </button>
            <button
              type="button"
              className="wb-icon-btn"
              title="更换工作区目录"
              aria-label="更换工作区目录"
              onClick={() => {
                setRootInput(root);
                setEditingRoot((v) => !v);
              }}
            >
              <Icon name="folder" size={14} />
            </button>
          </div>
        </div>
        {editingRoot && (
          <div className="wb-root-edit">
            <Input
              value={rootInput}
              onChange={(e) => setRootInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && rootInput.trim() && void applyRoot(rootInput)}
              autoFocus
            />
            <Button size="sm" disabled={!rootInput.trim()} onClick={() => void applyRoot(rootInput)}>
              打开
            </Button>
          </div>
        )}
        {editingRoot && hasUnsaved && (
          <div className="wb-row-note" data-tone="bad">
            有未保存的修改，换目录会丢弃它们
          </div>
        )}
        <FileTree
          ref={treeRef}
          root={root}
          activePath={activePath}
          onOpen={(p) => void openFile(p)}
          onCreated={(p) => void openFile(p)}
          onRenamed={handleRenamed}
          onDeleted={handleDeleted}
          openPaths={tabs.map((t) => t.path)}
        />
      </section>

      <section className="wb-main">
        <div className="wb-tabs" role="tablist">
          {tabs.map((t) => (
            <div
              key={t.path}
              role="tab"
              aria-selected={t.path === activePath}
              className="wb-tab"
              data-active={t.path === activePath || undefined}
              title={t.path}
              onClick={() => setActivePath(t.path)}
              onAuxClick={(e) => e.button === 1 && closeTab(t.path)}
            >
              <span className="wb-tab-name">{t.name}</span>
              {t.readOnly && <span className="wb-status-warn">只读</span>}
              <button
                type="button"
                className="wb-tab-x"
                aria-label={`关闭 ${t.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.path);
                }}
              >
                {t.dirty || t.eolChanged ? <span className="wb-dirty-dot" /> : <Icon name="close" size={12} />}
              </button>
            </div>
          ))}
          <span className="wb-tabs-sp" />
          <Button
            size="sm"
            variant="outline"
            className="wb-compile-btn"
            disabled={!activePath || compiling}
            title="用 ecj 编译当前文件所在模块，产物写到该模块的 classes 目录"
            onClick={() => void compileActive()}
          >
            <Icon name="play" size={12} />
            {compiling ? "编译中…" : "编译"}
          </Button>
        </div>

        {active?.readOnlyReason === "mixed" && (
          <div className="wb-banner">
            <Icon name="alertTriangle" size={14} />
            混合换行：保存会改动整个文件的行尾（SVN 里是整文件 diff），默认只读
            <div className="wb-banner-actions">
              <Button size="sm" variant="outline" onClick={() => unifyEol(active.path, "CRLF")}>
                统一为 CRLF 并编辑
              </Button>
              <Button size="sm" variant="outline" onClick={() => unifyEol(active.path, "LF")}>
                统一为 LF 并编辑
              </Button>
            </div>
          </div>
        )}
        {active?.readOnlyReason === "lossy" && (
          <div className="wb-banner" data-tone="bad">
            <Icon name="alertTriangle" size={14} />
            文件含无法无损往返的字节，保存会破坏原文件，已设为只读
          </div>
        )}
        {conflictPath !== null && conflictPath === activePath && (
          <div className="wb-banner" data-tone="bad">
            <Icon name="alertTriangle" size={14} />
            文件在磁盘上已被其他程序修改（如 AI 或 Eclipse），未保存
            <div className="wb-banner-actions">
              <Button size="sm" variant="outline" onClick={() => void reloadFile(conflictPath)}>
                放弃我的修改并重新加载
              </Button>
              <Button size="sm" variant="destructive" onClick={() => void saveFile(conflictPath, true)}>
                覆盖保存
              </Button>
            </div>
          </div>
        )}

        {showLargeHint && active && (
          <div className="wb-banner">
            <Icon name="info" size={14} />
            <span className="wb-banner-text">
              <b>{active.lines}</b> 行的大文件：为保证打字流畅，已关掉括号对着色、代码折叠与小地图；语法高亮、搜索、编译不受影响
            </span>
            <button
              type="button"
              className="wb-banner-x"
              title="关闭提示"
              aria-label="关闭提示"
              onClick={() => setSession({ largeHintDismissed: (v) => [...v, active.path] })}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        )}

        <div className="wb-editor">
          <EditorPane
            activePath={activePath}
            readOnly={active?.readOnly ?? false}
            reveal={reveal}
            heavy={heavyFile}
            onCursor={(line, column) => setCursor({ line, column })}
            onSave={() => activePath && void saveFile(activePath)}
          />
          {!active && (
            <div className="wb-editor-empty" style={{ pointerEvents: "none" }}>
              <EmptyState icon="file" description="从左侧文件树打开一个文件" />
            </div>
          )}
        </div>

        {panelOpen && (
          <BottomPanel
            root={root}
            tab={panelTab}
            onTab={setPanelTab}
            running={compiling}
            result={compileResult}
            log={compileLog}
            onOpenProblem={openProblem}
            onClose={() => setPanelOpen(false)}
          />
        )}

        <footer className="wb-status">
          <span className="wb-status-path" title={active?.path}>
            {active ? active.path : root}
          </span>
          <span className="wb-status-sp" />
          <button type="button" className="wb-status-btn" onClick={() => setPanelOpen((v) => !v)}>
            {panelOpen ? "隐藏面板" : "显示面板"}
          </button>
          {active && (
            <>
              <span>{languageOf(active.path)}</span>
              {activeMark && (
                <span
                  className="wb-status-enc"
                  title={
                    activeMark.registered
                      ? `磁盘内容是 UTF-8，但 Eclipse 偏好里登记为 ${activeMark.registered}`
                      : "磁盘内容是 UTF-8，但 Eclipse 偏好里没有登记，Eclipse 按工程默认的 GBK 读"
                  }
                >
                  Eclipse 按 GBK 读
                </span>
              )}
              <span>{active.encoding}{active.hasBom ? " BOM" : ""}</span>
              <span className={active.eolChanged ? "wb-status-warn" : undefined}>{active.eol}</span>
              <span>
                第 {cursor.line} 行，第 {cursor.column} 列
              </span>
            </>
          )}
        </footer>
      </section>

      <ConfirmDialog
        open={closingPath !== null}
        title="放弃未保存的修改？"
        description={`${baseName(closingPath ?? "")} 有未保存的修改，关闭后将丢失。`}
        variant="destructive"
        confirmLabel="放弃并关闭"
        onCancel={() => setClosingPath(null)}
        onConfirm={() => {
          if (closingPath) closeTab(closingPath, true);
          setClosingPath(null);
        }}
      />
    </div>
  );
}
