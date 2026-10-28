import { useCallback, useEffect, useRef, useState } from "react";
import { SearchBar } from "../search/SearchBar";
import { SearchResults } from "../search/SearchResults";
import { searchWorkspace, type SearchHit } from "../../lib/search";
import { getWorkspace, joinPath } from "../../lib/workspace";
import { getSearchForm, loadHistory, pushHistory, setSearchForm, type SearchForm } from "../../lib/searchStore";

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
export function SearchTab({ onOpenFile }: { onOpenFile: (path: string, line: number) => void }) {
  // 从模块仓库初始化：切走再回来，结果、折叠、滚动位置都还在
  const [form, setForm] = useState<SearchForm>(getSearchForm);
  const [root, setRoot] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>(loadHistory);
  const [loading, setLoading] = useState(false);
  // 每次搜索自增：慢请求回来时如果已有更新的请求，结果直接丢掉
  const seq = useRef(0);

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
    if (!q || loading) return;
    const mine = ++seq.current;
    setLoading(true);
    update({ error: null });
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
      if (mine !== seq.current) return;
      setHistory(pushHistory(q));
      update({ outcome, collapsed: [], scrollTop: 0 });
    } catch (e) {
      if (mine !== seq.current) return;
      // 正则语法错之类：清掉旧结果，否则「报错了但结果还在」会让人以为搜成功了
      update({ outcome: null, error: String(e) });
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  };

  const open = (hit: SearchHit) => {
    if (!root) return;
    // 后端回的是相对路径 + `/`，读写文件要绝对路径 + Windows 分隔符
    onOpenFile(joinPath(root, hit.path.replace(/\//g, "\\")), hit.line);
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
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <SearchBar
        form={form}
        history={history}
        loading={loading}
        update={update}
        onSearch={() => void run()}
        onKeyDown={onSearchKey}
      />
      <SearchResults form={form} update={update} loading={loading} onOpen={open} />
    </div>
  );
}
