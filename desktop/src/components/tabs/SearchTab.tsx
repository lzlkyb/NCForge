import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { SearchBar } from "../search/SearchBar";
import { SearchResults } from "../search/SearchResults";
import { SearchEditPanel } from "../search/SearchEditPanel";
import { ReplaceBar } from "../search/ReplaceBar";
import { runWorkspaceSearch } from "../../lib/searchRunner";
import { cancelWorkspaceSearch } from "../../lib/searchStore";
import { usePalette } from "../../lib/paletteStore";
import { sameSearchCriteria } from "../../lib/searchScope";
import type { ResultHit } from "../../lib/searchResults";
import { componentOptions, isSingleScope, toSearchOptions } from "../../lib/searchScope";
import { useNcManifest, useNcManifestAudit } from "../../hooks/useNcManifest";
import { getWorkspace, joinPath } from "../../lib/workspace";
import { useWorkspaceSelector } from "../../lib/workspaceSession";
import { useSearchPackStatus } from "../../lib/searchPackStatus";
import { SearchPackNotice } from "../search/SearchPackNotice";
import { JarSymbolResults } from "../search/JarSymbolResults";
import { SrcNoteResults } from "../search/SrcNoteResults";
import { LibraryFileResults } from "../search/LibraryFileResults";
import type { LibraryHit } from "../../lib/libraryFiles";
import { requestSearchOpen } from "../../lib/searchOpenRequest";
import { toast } from "../ui/toast";
import type { LinkedProject } from "../../lib/linkedProjects";
import {
  getSearchForm,
  loadHistory,
  setSearchForm,
  subscribeSearchForm,
  type SearchForm,
} from "../../lib/searchStore";
import { useSearchControls } from "../../hooks/useSearchControls";

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/**
 * 完整工程搜索：在顶部快速导航浮层内复用条件、结果与打开管道。
 *
 * 交互取舍（都照成熟工具的实际做法定的，理由见各处注释）：
 * - **不边输边搜**：后端是真实扫盘（7000 文件约 0.6s），边输边搜会把磁盘打满、
 *   结果还一直跳。回车或按「搜索」才真正执行——Eclipse 的 Ctrl+H 也是这个模型。
 * - **范围与文本选项常显**：浮层内的文件过滤与替换放在「更多」。
 * - **点命中打开文件并定位行**：调用方通过 `onOpenFile` 接到文件页的打开管道。
 * - **默认搜全部关联工程**：依赖链上的改动（接口在 A 工程、调用在 B 工程）是 NC
 *   二开的日常，只搜当前工程会把跨工程引用漏掉。替换与「编辑匹配」仍只对当前
 *   工作区开放——一次改写多个工程不可撤销，确认框也列不清跨工程的改动面。
 *
 * 条件栏在 `search/SearchBar`，结果区在 `search/SearchResults`；本文件只做取数与接线。
 * 组件保持「纯内容」：浮层负责入口输入与焦点，本组件负责条件与结果。
 */
export function SearchTab({
  projects,
  onOpenFile,
  onOpenJarClass,
  onOpenSrcNote,
  onOpenLibraryFile = hit => requestSearchOpen({ kind: "library", hit }),
  embedded = false,
}: {
  /** 关联工程（含当前工作区）；「全部工程」搜索与结果分组都靠它。 */
  embedded?: boolean;
  projects: LinkedProject[];
  onOpenFile: (path: string, line: number, column?: number) => void;
  /** 打开依赖 jar 里的某个 class（反编译查看）。 */
  onOpenJarClass: (jar: string, className: string) => void;
  /** 打开源码包内某个 .java（跳到指定行，看到带注释的原始源码）。 */
  onOpenSrcNote: (jar: string, className: string, line: number) => void;
  onOpenLibraryFile?: (hit: LibraryHit) => void;
}) {
  // 直接订阅模块仓库，不留本地副本：applyWorkspace 会调 resetSearchForm 清结果，
  // 本页被 ActivityPanel 保活、不会重新挂载——本地 useState 副本会让旧工作区的
  // 结果一直挂在屏幕上（替换虽被 stale 挡住，界面却自相矛盾）。
  const form = useSyncExternalStore(subscribeSearchForm, getSearchForm, getSearchForm);
  const history = loadHistory();
  const [editing, setEditing] = useState(false);
  // 「在跑」也读仓库：组件卸载不代表后端那次全盘扫描停了
  const loading = form.running;

  // ── 工作区根 ──
  // 订阅会话而不是挂载时读一次：本页被 ActivityPanel 保活，切工作区不会重挂载，
  // 挂载时那一次 getWorkspace 会让 root 永远是旧的——点命中拿旧相对路径拼旧 root，
  // 替换更糟（确认框显示旧工作区的改动面，实际写新工作区）。会话 root 由
  // applyWorkspace 在切换时写入，是唯一真源。
  // 只有 root 会变；订阅整份会话会让本页在每次 dirty 翻转、编译状态变化时重渲染。
  const sessionRoot = useWorkspaceSelector((s) => s.root);
  const [fallbackRoot, setFallbackRoot] = useState<string | null>(null);
  // 会话还没读出根（undefined：可能首屏就在搜索页，没人先读过配置）时兜底读一次
  useEffect(() => {
    if (sessionRoot !== undefined) return;
    let alive = true;
    getWorkspace()
      .then((r) => alive && setFallbackRoot(r))
      .catch(() => alive && setFallbackRoot(null));
    return () => {
      alive = false;
    };
  }, [sessionRoot]);
  const root = sessionRoot ?? fallbackRoot;

  // 建包提示：首次打开/换工作区时在后台建内容包，这段时间搜索仍走磁盘。
  // 面板不见时连轮询都不启动；换工作区与每次搜索各唤醒一次。
  const palette = usePalette();
  const { status: packStatus, refresh: refreshPackStatus } = useSearchPackStatus(
    palette.open && palette.mode === "search",
  );
  useEffect(() => {
    void refreshPackStatus();
  }, [root, refreshPackStatus]);
  useEffect(() => () => cancelWorkspaceSearch(), []);

  // 业务组件清单（manifest）：既是「按组件」的范围来源，也是那个范围可不可用的判据。
  // 读不到就是空数组 → 范围芯片置灰，不让用户选到一个会静默变成全工程的范围。
  const components = useNcManifest(root ?? null);
  const componentChoices = useMemo(() => componentOptions(components), [components]);
  // 登记缺口：组件菜单底部那行「另有 N 个模块未登记」，解释「为什么 aim 不在清单里」
  const audit = useNcManifestAudit(root ?? null);

  const update = useCallback((patch: Partial<SearchForm>) => {
    // 仓库自己合并并广播；写完后本组件经由订阅拿到新的 form
    setSearchForm(patch);
  }, []);

  /**
   * 从当前表单现算搜索条件（纯函数在 `lib/searchScope::toSearchOptions`）。
   *
   * 抽出来是为了让「替换」与「搜索」用**同一份** options：后端的替换复用搜索的候选
   * 收集逻辑，两边参数必须逐字一致，否则「搜到的」和「会被改的」不是同一批文件。
   */
  const buildOptions = toSearchOptions;

  const run = async () => {
    setEditing(false);
    await runWorkspaceSearch(root);
    void refreshPackStatus();
  };

  /**
   * 换范围 / 换组件就丢掉旧结果——这条状态机在仓库里（`applySearchScope`），
   * 这里只负责收起编辑态；「为什么必须清」写在那个函数上。
   * 键盘同理（Enter 搜索 / Esc 清空）：都搬去了 `hooks/useSearchControls`。
   */
  const { changeScope, pickComponent, onSearchKey } = useSearchControls({
    form,
    leaveEditing: () => setEditing(false),
    run: () => void run(),
    clearQuery: () => update({ query: "" }),
  });

  const resolvePath = (hit: ResultHit) => {
    const hitRoot = hit.root ?? (form.outcomeRoot !== null && form.outcomeRoot !== root ? null : root);
    return hitRoot ? joinPath(hitRoot, hit.path.replace(/\//g, "\\")) : null;
  };
  const open = (hit: ResultHit) => {
    // 全部工程的结果自带工程根；当前工作区结果要拿搜索时记下的 root 拼。
    const path = resolvePath(hit);
    if (!path) {
      if (!root) toast("尚未打开工作区：先在代码页选一个目录再搜", "warning");
      // 结果来自别的工作区：拿旧相对路径拼新 root 只会被白名单拒掉，报一串英文
      else toast("工作区已变更，请重新搜索", "warning");
      return;
    }
    // 后端回的是相对路径 + `/`，读写文件要绝对路径 + Windows 分隔符。
    // ranges 是行内 UTF-16 偏移，+1 换成 1 基列号——只跳到行首的话长行还要肉眼找。
    onOpenFile(
      path,
      hit.line,
      (hit.ranges[0]?.start ?? 0) + 1,
    );
  };

  // 结果是别的工作区搜出来的（只对当前范围有意义；全部工程的结果自带工程根）：
  // 替换必须禁用。否则确认框拿旧工作区的改动面骗人，实际改写的是新工作区的文件。
  const stale =
    isSingleScope(form.scope) && form.outcomeRoot !== null && form.outcomeRoot !== root;
  // 组件范围与当前工程一样只碰当前工作区：替换、编辑匹配都按这条路开放
  const single = isSingleScope(form.scope);

  const projectCount = projects.filter((p) => p.root).length;
  const currentName =
    projects.find((p) => p.root && root && p.root.toLowerCase() === root.toLowerCase())?.name ??
    (root ? baseName(root) : "");
  const jarResults = <>
    <LibraryFileResults onOpen={onOpenLibraryFile} />
    <JarSymbolResults onOpenClass={onOpenJarClass} />
    <SrcNoteResults onOpenSource={onOpenSrcNote} />
  </>;

  return (
    <div className="wb-search-tool flex min-h-0 flex-1 flex-col bg-background">
      <SearchBar
        embedded={embedded}
        form={form}
        history={history}
        loading={loading}
        projectCount={projectCount}
        currentName={currentName}
        components={componentChoices}
        audit={audit}
        update={update}
        onScope={changeScope}
        onPickComponent={pickComponent}
        onSearch={() => void run()}
        onKeyDown={e => { if (!(embedded && e.key === "Escape")) onSearchKey(e); }}
      />
      <SearchPackNotice status={packStatus} />
      {/* 浮层里的依赖命中随结果滚动，避免占满低窗口；独立视图保留原布局。 */}
      {!embedded && jarResults}
      {single && (!embedded || form.more) && (
        <ReplaceBar
          form={form}
          update={update}
          options={buildOptions(form)}
          onReSearch={() => void run()}
          stale={stale}
        />
      )}
      {editing && single && form.outcome && root ? (
        <SearchEditPanel
          hits={form.outcome.hits}
          root={root}
          onClose={(refresh) => {
            setEditing(false);
            if (refresh) void run();
          }}
        />
      ) : (
        <SearchResults
          embedded={embedded}
          supplements={embedded ? jarResults : undefined}
          form={form}
          update={update}
          loading={loading}
          onOpen={open}
          resolvePath={resolvePath}
          onEdit={
            single && root && !stale && !loading && !form.outcome?.truncated && !form.outcome?.cancelled && form.outcomeOptions && sameSearchCriteria(form.outcomeOptions, buildOptions(form)) ? () => setEditing(true) : undefined
          }
        />
      )}
    </div>
  );
}
