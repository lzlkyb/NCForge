import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "../ui/icon";
import {
  getSearchForm,
  setSearchForm,
  subscribeSearchForm,
} from "../../lib/searchStore";
import { jarNeedleReady, searchJarSymbols } from "../../lib/jarSymbolSearch";

/**
 * jar 内符号结果段：一次全文搜索跑完后，用同一个查询词再搜一遍依赖 jar 的常量池。
 *
 * 为什么单独一段而不是混进 `SearchResults`：
 * - 来源不同——这些命中不在任何工作区文件里，替换 / 编辑匹配都不能碰；
 * - 打开方式不同——点命中走 CFR 反编译，不是打开磁盘文件；
 * - 体量不同——全文结果动辄几百条，符号结果是「词 → 位置」，语义就不是一回事。
 *
 * 自己订阅仓库、自己取数：这样 SearchTab 只需要一行挂载，不用为它多背一份状态。
 */
export function JarSymbolResults({
  onOpenClass,
}: {
  /** 打开 jar 内某个 class（反编译查看）。 */
  onOpenClass: (jar: string, className: string) => void;
}) {
  const form = useSyncExternalStore(subscribeSearchForm, getSearchForm, getSearchForm);
  // 请求序号：连续敲回车时旧请求回来不能覆盖新结果。用 ref 而不是 state——
  // state 的 ++ 只改闭包里那个值，下一次渲染又回到旧值，序号就白算了。
  const seq = useRef(0);
  // 自己这段的 IPC 在飞。stale() 要对全部 jar 做一次 stat（P1 节流前是 100ms 量级），
  // 不给反馈就是「迟一点突然出现」。
  const [loading, setLoading] = useState(false);

  // 触发条件是一次全文搜索**完成**：有 outcome 且不在跑。换工作区 / 换范围会把
  // outcome 清空，这一段自然跟着消失——不会拿新工作区的词显示旧 jar 的结果。
  // 词只认 `outcomeQuery`（那次搜索完成时的快照），不认输入框实时值：拿实时值当
  // 依赖会让搜完后每敲一个字都重发一路全 jar 扫描，而主结果还停在旧词上。
  const done = !form.running && (form.outcome !== null || form.projectOutcome !== null);
  const query = (form.outcomeQuery ?? "").trim();

  useEffect(() => {
    // 门槛与源码注释段同一条口径（`jarNeedleReady`）：中文单字放行，单字母挡掉
    if (!done || !jarNeedleReady(query)) {
      setLoading(false);
      // 只在真的从「有结果」变「没结果」时清：无条件写仓库会让每次渲染都广播一次
      if (form.jarSymbols !== null) setSearchForm({ jarSymbols: null });
      return;
    }
    let alive = true;
    const mine = ++seq.current;
    setLoading(true);
    searchJarSymbols(query, 50)
      .then((r) => {
        if (alive && mine === seq.current) setSearchForm({ jarSymbols: r });
      })
      .catch(() => {
        // jar 索引不可用（没有 NC home / 命令失败）不该让搜索页报错，
        // 静默跳过这一段即可
        if (alive && mine === seq.current) setSearchForm({ jarSymbols: null });
      })
      .finally(() => {
        // 也要判序号：旧请求回来不能把新请求的「搜索中」收掉
        if (alive && mine === seq.current) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done, query]);

  const result = form.jarSymbols;
  const failed = result?.error ?? "";
  if (!done) return null;
  // 🔴 `building` 也要渲染：索引还没建好时没有任何命中，但这时恰恰必须告诉用户
  // 「不是没做，是在建」——否则第一次用只会看到这一段凭空消失。
  // loading 同理：请求在飞时先亮个壳，别让界面像卡住了。
  // `failed` 同理：建失败也是 0 命中，静默消失等于把「建不起来」说成「没问题」。
  if (!result && !loading) return null;
  if (result && !result.building && !failed && result.items.length === 0 && !loading) return null;

  return (
    <section className="flex-shrink-0 border-b border-border" aria-label="依赖 jar 内的符号">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 bg-muted/40 px-3 py-1 text-[12px]">
        <Icon name="package" size={13} className="flex-shrink-0 text-muted-foreground" />
        <span className="font-semibold">依赖 jar 内</span>
        {loading ? (
          <span className="text-muted-foreground">搜索中…</span>
        ) : (
          // building / 建失败时不说命中数：这次没有任何命中可言，
          // 报个上次的条数只会让人以为库里没这些词。
          !result?.building && !failed && (
            <span className="text-muted-foreground">
              共 <b>{result?.total ?? 0}</b> 个词命中
              {result !== null && result.items.length < result.total &&
                ` · 显示前 ${result.items.length}`}
              {` · ${result?.elapsedMs ?? 0}ms`}
            </span>
          )
        )}
        <span className="flex-1" />
        {!loading && result?.stale && (
          <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[11px] text-warning-ink">
            jar 已变动，正在后台重建，以下来自旧索引
          </span>
        )}
        {!loading && result?.truncated && (
          <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[11px] text-warning-ink">
            扫描到上限，结果可能不全
          </span>
        )}
      </div>

      {/* ── 常驻说明：说清「什么搜得到、什么搜不到」──
          class 文件物理上不含注释（javac 编译时剥离），拿注释里的关键词搜 jar
          必然 0 命中。不写这一行，用户只会以为功能没做。所以紧接着补一句
          「注释在下一段」——两段挨着，不说清楚就像自相矛盾。 */}
      <p className="border-b border-border px-3 py-1 text-[11px] leading-relaxed text-muted-foreground">
        可搜：类名、包名、字段、常量、方法名、字符串文案。
        <b className="text-foreground">搜不到注释</b>——class 文件不含注释（编译时已剥离），
        要搜注释看下面的「jar 内源码注释」段。
      </p>

      {loading ? (
        <div className="px-3 py-2 text-[11.5px] text-muted-foreground">搜索中…</div>
      ) : failed ? (
        // 建失败不能继续演「正在后台建立」：那是永远等不到的假进度
        <div className="px-3 py-2 text-[11.5px] text-destructive-ink">
          jar 符号索引建立失败：{failed}
          。建索引要解一遍全部依赖 jar 的常量池，磁盘满或杀软占用索引文件时会这样；
          清出空间、或把 NC home 加进杀软白名单后重启应用再试。
        </div>
      ) : result?.building ? (
        <div className="px-3 py-2 text-[11.5px] text-muted-foreground">
          jar 符号索引正在后台建立（首次要解一遍全部依赖 jar 的常量池），
          建完这段就会出现结果。
        </div>
      ) : (
        <ul className="max-h-64 overflow-auto">
          {(result?.items ?? []).map((hit) => {
            // 后端每词最多列 8 处，`placesTotal` 才是真实命中处数：拿
            // `places.length` 算「另有 N 处」会把 8 处以外的全吞掉
            const shown = hit.places.slice(0, 3);
            const rest = (hit.placesTotal ?? hit.places.length) - shown.length;
            return (
              <li key={`${hit.term}:${hit.score}`}>
                {shown.map((place, i) => {
                  const jarName = place.jar.split(/[\\/]/).pop() ?? place.jar;
                  return (
                    <button
                      key={`${place.jar}:${place.class}:${i}`}
                      type="button"
                      onClick={() => onOpenClass(place.jar, place.class)}
                      title={`${place.jar}\n${place.class}\n点开反编译查看`}
                      className="flex w-full items-center gap-2 px-3 py-1 text-left text-[12px] hover:bg-accent"
                    >
                      <span className="shrink-0 font-mono text-[11.5px] text-primary">
                        {hit.term}
                      </span>
                      <span className="truncate text-muted-foreground" title={place.class}>
                        {place.class}
                      </span>
                      <span className="ml-auto shrink-0 truncate text-[11px] text-muted-foreground/70" title={place.jar}>
                        {jarName}
                      </span>
                    </button>
                  );
                })}
                {rest > 0 && (
                  <div className="px-3 pb-1 text-[11px] text-muted-foreground/70">
                    另有 {rest} 处
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
