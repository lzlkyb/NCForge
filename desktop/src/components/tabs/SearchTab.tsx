import { DockRegion } from "../workspace/WorkbenchDock";
import { useCallback, useEffect, useState } from "react";
import { SearchBar } from "../search/SearchBar";
import { SearchResults } from "../search/SearchResults";
import { searchWorkspace, type SearchHit } from "../../lib/search";
import { getWorkspace, joinPath } from "../../lib/workspace";
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
  const [root, setRoot] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>(loadHistory);
  // 「在跑」也读仓库：组件卸载不代表后端那次全盘扫描停了
  const loading = form.running;

  const update = useCallback((patch: Partial<SearchForm>) => {
    setForm((f) => {
      const next = { ...f, ...patch };
      setSearchForm(next);
      return next;
    });
  }, []);

  useEffect(() => {
    getWorkspace()
      .then(setRoot)
      .catch(() => setRoot(null));
  }, []);

  const run = async () => {
    const q = form.query.trim();
    if (!q || form.running) return;
    const mine = nextSearchSeq();
    update({ running: true, error: null });
    try {
      const outcome = await searchWorkspace({
        // 正则模式按原样传（前后空格有意义），纯文本模式传 trim 过的
        text: form.regex ? form.query : q,
        caseSensitive: form.caseSensitive,
        // 正则开着时「整词」不生效（后端也忽略）：想整词自己写 \b，与 IDEA 一致
        wholeWord: form.regex ? false : form.wholeWord,
        regex: form.regex,
        include: form.include.trim(),
      });
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
      <SearchResults form={form} update={update} loading={loading} onOpen={open} />
    </div></DockRegion>
  );
}
