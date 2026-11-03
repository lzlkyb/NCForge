import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { SearchBar } from "../search/SearchBar";
import { SearchResults } from "../search/SearchResults";
import { SearchEditPanel } from "../search/SearchEditPanel";
import { ReplaceBar } from "../search/ReplaceBar";
import {
  searchProjects,
  searchWorkspace,
  type SearchOptions,
} from "../../lib/search";
import type { ResultHit } from "../../lib/searchResults";
import { getWorkspace, joinPath } from "../../lib/workspace";
import { useWorkspaceSelector } from "../../lib/workspaceSession";
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
  type SearchScope,
} from "../../lib/searchStore";

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
}: {
  /** 关联工程（含当前工作区）；「全部工程」搜索与结果分组都靠它。 */
  projects: LinkedProject[];
  onOpenFile: (path: string, line: number, column?: number) => void;
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

  const update = useCallback((patch: Partial<SearchForm>) => {
    // 仓库自己合并并广播；写完后本组件经由订阅拿到新的 form
    setSearchForm(patch);
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
          collapsed: [],
        });
      } else {
        const outcome = await searchWorkspace(opts);
        if (mine !== currentSearchSeq()) return;
        setHistory(pushHistory(q));
        // 结果里存的是相对路径，必须记下它属于哪个工作区
        update({
          outcome,
          projectOutcome: null,
          outcomeRoot: root,
          outcomeOptions: opts,
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
        error: String(e),
      });
    } finally {
      if (mine === currentSearchSeq()) update({ running: false });
    }
  };

  /**
   * 换搜索范围就丢掉旧结果。
   *
   * 不换结果的话会出现最坏的一种界面：切到「全部工程」后屏幕上是当前工程的结果，
   * 汇总行却按全部工程口径念；反过来，切回「当前工程」后替换入口会对着上一次
   * 全部工程的结果开确认框——它没有 outcome，替换按钮其实是禁用的，但用户看到的
   * 是「搜到了却替换不了」。查询词与选项保留，换范围往往就是想用同样的词再搜一遍。
   */
  const changeScope = (scope: SearchScope) => {
    if (scope === form.scope) return;
    // 正在跑时范围按钮是禁用的，这里仍是二道网：顶掉旧请求序号，它的结果不会写回来。
    void nextSearchSeq();
    setEditing(false);
    update({
      scope,
      outcome: null,
      projectOutcome: null,
      outcomeRoot: null,
      outcomeOptions: null,
      collapsed: [],
      error: null,
      running: false,
      replaceOutcome: null,
    });
  };

  const open = (hit: ResultHit) => {
    // 全部工程的结果自带工程根；当前工作区结果要拿搜索时记下的 root 拼。
    const hitRoot =
      hit.root ??
      (form.outcomeRoot !== null && form.outcomeRoot !== root ? null : root);
    if (!hitRoot) {
      if (!root) toast("尚未打开工作区：先在代码页选一个目录再搜", "warning");
      // 结果来自别的工作区：拿旧相对路径拼新 root 只会被白名单拒掉，报一串英文
      else toast("工作区已变更，请重新搜索", "warning");
      return;
    }
    // 后端回的是相对路径 + `/`，读写文件要绝对路径 + Windows 分隔符。
    // ranges 是行内 UTF-16 偏移，+1 换成 1 基列号——只跳到行首的话长行还要肉眼找。
    onOpenFile(
      joinPath(hitRoot, hit.path.replace(/\//g, "\\")),
      hit.line,
      (hit.ranges[0]?.start ?? 0) + 1,
    );
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

  // 结果是别的工作区搜出来的（只对当前范围有意义；全部工程的结果自带工程根）：
  // 替换必须禁用。否则确认框拿旧工作区的改动面骗人，实际改写的是新工作区的文件。
  const stale =
    form.scope === "current" && form.outcomeRoot !== null && form.outcomeRoot !== root;

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
        update={update}
        onScope={changeScope}
        onSearch={() => void run()}
        onKeyDown={onSearchKey}
      />
      {form.scope === "current" && (
        <ReplaceBar
          form={form}
          update={update}
          options={buildOptions(form)}
          onReSearch={() => void run()}
          stale={stale}
        />
      )}
      {editing && form.scope === "current" && form.outcome && root ? (
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
          onEdit={
            form.scope === "current" && root && !stale && form.outcome
              ? () => setEditing(true)
              : undefined
          }
        />
      )}
    </div>
  );
}
