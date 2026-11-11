import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { SearchBar } from "../search/SearchBar";
import { SearchResults } from "../search/SearchResults";
import { SearchEditPanel } from "../search/SearchEditPanel";
import { ReplaceBar } from "../search/ReplaceBar";
import { searchProjects, searchWorkspace } from "../../lib/search";
import type { ResultHit } from "../../lib/searchResults";
import { componentOptions, isSingleScope, toSearchOptions } from "../../lib/searchScope";
import { useNcManifest, useNcManifestAudit } from "../../hooks/useNcManifest";
import { getWorkspace, joinPath } from "../../lib/workspace";
import { useWorkspaceSelector } from "../../lib/workspaceSession";
import { useSidebarView } from "../../lib/sidebarView";
import { useSearchPackStatus } from "../../lib/searchPackStatus";
import { SearchPackNotice } from "../search/SearchPackNotice";
import { JarSymbolResults } from "../search/JarSymbolResults";
import { SrcNoteResults } from "../search/SrcNoteResults";
import { toast } from "../ui/toast";
import type { LinkedProject } from "../../lib/linkedProjects";
import {
  currentSearchSeq,
  getSearchForm,
  loadHistory,
  nextSearchSeq,
  pushHistory,
  setSearchForm,
  subscribeSearchForm,
  type SearchForm,
} from "../../lib/searchStore";
import { useSearchControls } from "../../hooks/useSearchControls";

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/**
 * 全工程搜索（M2）。现在是文件页侧栏的一个视图，不再占主导航页签。
 *
 * 交互取舍（都照成熟工具的实际做法定的，理由见各处注释）：
 * - **不边输边搜**：后端是真实扫盘（7000 文件约 0.6s），边输边搜会把磁盘打满、
 *   结果还一直跳。回车或按「搜索」才真正执行——Eclipse 的 Ctrl+H 也是这个模型。
 * - **选项常显**：不学 VS Code 把过滤收进「⋯」——收纳后不给快捷键基本想不起来。
 * - **点命中打开文件并定位行**：调用方通过 `onOpenFile` 接到文件页的打开管道。
 * - **默认搜全部关联工程**：依赖链上的改动（接口在 A 工程、调用在 B 工程）是 NC
 *   二开的日常，只搜当前工程会把跨工程引用漏掉。替换与「编辑匹配」仍只对当前
 *   工作区开放——一次改写多个工程不可撤销，确认框也列不清跨工程的改动面。
 *
 * 条件栏在 `search/SearchBar`，结果区在 `search/SearchResults`；本文件只做取数与接线。
 * 组件保持「纯内容」：不自己往停靠区 portal，文件页把它放进侧栏槽位里。
 */
export function SearchTab({
  projects,
  onOpenFile,
  onOpenJarClass,
  onOpenSrcNote,
}: {
  /** 关联工程（含当前工作区）；「全部工程」搜索与结果分组都靠它。 */
  projects: LinkedProject[];
  onOpenFile: (path: string, line: number, column?: number) => void;
  /** 打开依赖 jar 里的某个 class（反编译查看）。 */
  onOpenJarClass: (jar: string, className: string) => void;
  /** 打开源码包内某个 .java（跳到指定行，看到带注释的原始源码）。 */
  onOpenSrcNote: (jar: string, className: string, line: number) => void;
}) {
  // 直接订阅模块仓库，不留本地副本：applyWorkspace 会调 resetSearchForm 清结果，
  // 本页被 ActivityPanel 保活、不会重新挂载——本地 useState 副本会让旧工作区的
  // 结果一直挂在屏幕上（替换虽被 stale 挡住，界面却自相矛盾）。
  const form = useSyncExternalStore(subscribeSearchForm, getSearchForm, getSearchForm);
  const [history, setHistory] = useState<string[]>(loadHistory);
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
  const sideView = useSidebarView();
  const { status: packStatus, refresh: refreshPackStatus } = useSearchPackStatus(
    sideView === "search",
  );
  useEffect(() => {
    void refreshPackStatus();
  }, [root, refreshPackStatus]);

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
    // running 从仓库读：连点两次时第二次的事件闭包还是上一次渲染的，
    // 读组件 state 会漏掉「已经在跑」这个事实，变成两个全盘扫描并行
    if (getSearchForm().running) return;
    const q = form.query.trim();
    if (!q) return;
    const mine = nextSearchSeq();
    // 条件与结果必须同源：这份快照既用于本次搜索，也用于之后的「全部替换」。
    // 用表单实时值去替换，会在「搜完改词没重搜」时改写另一批文件。
    const opts = buildOptions(form);
    const scope = form.scope;
    // 新搜索一开始，上次替换留下的「结果已过期」提示就作废了；
    // 编辑预览里的行号也只对旧结果有效，跟着退出。
    setEditing(false);
    update({ running: true, error: null, replaceOutcome: null });
    try {
      if (scope === "all") {
        const projectOutcome = await searchProjects(opts);
        if (mine !== currentSearchSeq()) return;
        setHistory(pushHistory(q));
        // outcome 必须清空：替换与编辑匹配只认它，全部工程的结果不能被它们当成
        // 「当前工作区的结果」去改写磁盘。
        update({
          projectOutcome,
          outcome: null,
          outcomeRoot: root,
          outcomeOptions: null,
          // jar 两段跟着**这次搜索的词**走，不是输入框实时值（搜完再打字不该重发 IPC）
          outcomeQuery: q,
          collapsed: [],
        });
      } else {
        const outcome = await searchWorkspace(opts, true);
        if (mine !== currentSearchSeq()) return;
        setHistory(pushHistory(q));
        // 结果里存的是相对路径，必须记下它属于哪个工作区
        update({
          outcome,
          projectOutcome: null,
          outcomeRoot: root,
          outcomeOptions: opts,
          outcomeQuery: q,
          collapsed: [],
        });
      }
    } catch (e) {
      if (mine !== currentSearchSeq()) return;
      // 正则语法错之类：清掉旧结果，否则「报错了但结果还在」会让人以为搜成功了
      update({
        outcome: null,
        projectOutcome: null,
        outcomeRoot: null,
        outcomeOptions: null,
        outcomeQuery: null,
        error: String(e),
      });
    } finally {
      // 这次搜索可能刚给一个新工作区排了建包任务，重新问一次状态把提示点亮
      void refreshPackStatus();
      if (mine === currentSearchSeq()) update({ running: false });
    }
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

  return (
    <div className="wb-search-tool flex min-h-0 flex-1 flex-col bg-background">
      <SearchBar
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
        onKeyDown={onSearchKey}
      />
      <SearchPackNotice status={packStatus} />
      {/* jar 内符号段：自己订阅仓库、自己取数，这里只负责给它一个打开管道 */}
      <JarSymbolResults onOpenClass={onOpenJarClass} />
      {/* jar 内源码注释段：与上一段互补（class 里没有注释，只能走 _src.jar） */}
      <SrcNoteResults onOpenSource={onOpenSrcNote} />
      {single && (
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
          form={form}
          update={update}
          loading={loading}
          onOpen={open}
          resolvePath={resolvePath}
          onEdit={
            single && root && !stale && form.outcome ? () => setEditing(true) : undefined
          }
        />
      )}
    </div>
  );
}
