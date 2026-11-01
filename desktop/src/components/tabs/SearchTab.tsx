import { DockRegion } from "../workspace/WorkbenchDock";
import { useCallback, useEffect, useState } from "react";
import { SearchBar } from "../search/SearchBar";
import { SearchResults } from "../search/SearchResults";
import { ReplaceBar } from "../search/ReplaceBar";
import { searchWorkspace, type SearchHit, type SearchOptions } from "../../lib/search";
import { getWorkspace, joinPath } from "../../lib/workspace";
import { useWorkspaceSession } from "../../lib/workspaceSession";
import { toast } from "../ui/toast";
import {
  currentSearchSeq,
  getSearchForm,
  loadHistory,
  nextSearchSeq,
  pushHistory,
  setSearchForm,
  type SearchForm,
} from "../../lib/searchStore";

/**
 * 全工程搜索页（M2）。
 *
 * 交互取舍（都照成熟工具的实际做法定的，理由见各处注释）：
 * - **不边输边搜**：后端是真实扫盘（7000 文件约 0.6s），边输边搜会把磁盘打满、
 *   结果还一直跳。回车或按「搜索」才真正执行——Eclipse 的 Ctrl+H 也是这个模型。
 * - **结果放整页**：侧栏那种窄面板放不下「路径 + 行号 + 整行代码」。
 * - **选项常显**：整页横向空间够，不学 VS Code 把过滤收进「⋯」——
 *   收纳后不给快捷键基本想不起来。
 * - **点命中去 Files 页并定位行**，靠 lib/openFileRequest 这条单向管道。
 *
 * 条件栏在 `search/SearchBar`，结果区在 `search/SearchResults`；本文件只做取数与接线。
 */
export function SearchTab({
  onOpenFile,
}: {
  onOpenFile: (path: string, line: number, column?: number) => void;
}) {
  // 从模块仓库初始化：切走再回来，结果、折叠、滚动位置都还在
  const [form, setForm] = useState<SearchForm>(getSearchForm);
  const [history, setHistory] = useState<string[]>(loadHistory);
  // 「在跑」也读仓库：组件卸载不代表后端那次全盘扫描停了
  const loading = form.running;

  // ── 工作区根 ──
  // 订阅会话而不是挂载时读一次：本页被 ActivityPanel 保活，切工作区不会重挂载，
  // 挂载时那一次 getWorkspace 会让 root 永远是旧的——点命中拿旧相对路径拼旧 root，
  // 替换更糟（确认框显示旧工作区的改动面，实际写新工作区）。会话 root 由
  // applyWorkspace 在切换时写入，是唯一真源。
  const session = useWorkspaceSession();
  const [fallbackRoot, setFallbackRoot] = useState<string | null>(null);
  // 会话还没读出根（undefined：可能首屏就在搜索页，没人先读过配置）时兜底读一次
  useEffect(() => {
    if (session.root !== undefined) return;
    let alive = true;
    getWorkspace()
      .then((r) => alive && setFallbackRoot(r))
      .catch(() => alive && setFallbackRoot(null));
    return () => {
      alive = false;
    };
  }, [session.root]);
  const root = session.root ?? fallbackRoot;

  const update = useCallback((patch: Partial<SearchForm>) => {
    setForm((f) => {
      const next = { ...f, ...patch };
      setSearchForm(next);
      return next;
    });
  }, []);

  /**
   * 从当前表单现算搜索条件。
   *
   * 抽出来是为了让「替换」与「搜索」用**同一份** options：后端的替换复用搜索的候选
   * 收集逻辑，两边参数必须逐字一致，否则「搜到的」和「会被改的」不是同一批文件。
   */
  const buildOptions = (f: SearchForm): SearchOptions => ({
    // 正则模式按原样传（前后空格有意义），纯文本模式传 trim 过的
    text: f.regex ? f.query : f.query.trim(),
    caseSensitive: f.caseSensitive,
    // 正则开着时「整词」不生效（后端也忽略）：想整词自己写 \b，与 IDEA 一致
    wholeWord: f.regex ? false : f.wholeWord,
    regex: f.regex,
    include: f.include.trim(),
  });

  const run = async () => {
    // running 从仓库读：连点两次时第二次的事件闭包还是上一次渲染的，
    // 读组件 state 会漏掉「已经在跑」这个事实，变成两个全盘扫描并行
    if (getSearchForm().running) return;
    const q = form.query.trim();
    if (!q) return;
    const mine = nextSearchSeq();
    // 新搜索一开始，上次替换留下的「结果已过期」提示就作废了
    update({ running: true, error: null, replaceOutcome: null });
    try {
      const outcome = await searchWorkspace(buildOptions(form));
      if (mine !== currentSearchSeq()) return;
      setHistory(pushHistory(q));
      // 结果里存的是相对路径，必须记下它属于哪个工作区
      update({ outcome, outcomeRoot: root, collapsed: [], scrollTop: 0 });
    } catch (e) {
      if (mine !== currentSearchSeq()) return;
      // 正则语法错之类：清掉旧结果，否则「报错了但结果还在」会让人以为搜成功了
      update({ outcome: null, outcomeRoot: null, error: String(e) });
    } finally {
      if (mine === currentSearchSeq()) update({ running: false });
    }
  };

  const open = (hit: SearchHit) => {
    if (!root) {
      toast("尚未打开工作区：先在文件页选一个目录再搜", "warning");
      return;
    }
    // 结果来自别的工作区：拿旧相对路径拼新 root 只会被白名单拒掉，报一串英文
    if (form.outcomeRoot !== null && form.outcomeRoot !== root) {
      toast("工作区已变更，请重新搜索", "warning");
      return;
    }
    // 后端回的是相对路径 + `/`，读写文件要绝对路径 + Windows 分隔符。
    // ranges 是行内 UTF-16 偏移，+1 换成 1 基列号——只跳到行首的话长行还要肉眼找。
    onOpenFile(joinPath(root, hit.path.replace(/\//g, "\\")), hit.line, (hit.ranges[0]?.start ?? 0) + 1);
  };

  const onSearchKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void run();
    } else if (e.key === "Escape") {
      e.preventDefault();
      update({ query: "" });
    }
  };

  // 结果是别的工作区搜出来的：替换必须禁用。否则确认框拿旧工作区的改动面骗人，
  // 实际改写的是新工作区的文件（resetSearchForm 正常情况下已经清掉，这是二道网）
  const stale = form.outcomeRoot !== null && form.outcomeRoot !== root;

  return (
    <DockRegion region="sidebar"><div className="wb-search-tool flex min-h-0 flex-1 flex-col bg-background">
      <SearchBar
        form={form}
        history={history}
        loading={loading}
        update={update}
        onSearch={() => void run()}
        onKeyDown={onSearchKey}
      />
      <ReplaceBar form={form} update={update} options={buildOptions(form)} onReSearch={() => void run()} stale={stale} />
      <SearchResults form={form} update={update} loading={loading} onOpen={open} />
    </div></DockRegion>
  );
}
