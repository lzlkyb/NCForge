import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "../ui/icon";
import {
  getSearchForm,
  setSearchForm,
  subscribeSearchForm,
} from "../../lib/searchStore";
import { searchSrcNotes, srcNoteClass, SRC_NOTE_LIMIT } from "../../lib/srcNoteSearch";
import { JAR_SEARCH_MAX_LIMIT, jarNeedleReady } from "../../lib/jarSymbolSearch";

/**
 * jar 内**源码注释**结果段：一次全文搜索跑完后，用同一个查询词再搜一遍 `_src.jar` 的注释。
 *
 * 为什么单独一段：注释命中不属于任何工作区文件，替换 / 编辑匹配都不能碰它；
 * 打开方式也不同——走 jdt.ls 的 source lookup（它自己会找到同名 `_src.jar`），
 * 用户看到的是带注释的原始源码，而不是 CFR 反编译结果。
 *
 * 自己订阅仓库、自己取数：SearchTab 只负责给一个打开管道。
 */
export function SrcNoteResults({
  onOpenSource,
}: {
  /** 打开源码包内某个 .java（跳到指定行）。 */
  onOpenSource: (jar: string, className: string, line: number) => void;
}) {
  const form = useSyncExternalStore(subscribeSearchForm, getSearchForm, getSearchForm);
  // 请求序号：连续敲回车时旧请求回来不能覆盖新结果
  const seq = useRef(0);
  // 自己这段的 IPC 在飞。后端建索引 / 找 jar 要 100ms 量级，不给反馈就是
  // 「迟一点突然出现」——用户看不出到底是没搜到还是在跑。
  const [loading, setLoading] = useState(false);
  // 「加载更多 / 重试」的请求参数，绑上查询词：换词后自动回到首屏条数，不会拿
  // 上一个词提过的上限去搜新词。nonce 让「重试」在参数没变时也能重跑一次。
  const [reload, setReload] = useState<{ query: string; limit: number; nonce: number } | null>(null);

  // 与 jar 符号段同一个触发点：一次全文搜索**完成**，且用**那次搜索的词**
  // （outcomeQuery 快照）。输入框实时值每敲一个字都变，拿它当依赖会让搜完后
  // 每键都重发 IPC，而主结果还停在旧词上——两段与主结果对不上。
  const done = !form.running && (form.outcome !== null || form.projectOutcome !== null);
  const query = (form.outcomeQuery ?? "").trim();
  const ask = reload !== null && reload.query === query ? reload : null;
  const limit = ask?.limit ?? SRC_NOTE_LIMIT;
  const nonce = ask?.nonce ?? 0;

  useEffect(() => {
    if (!done || !jarNeedleReady(query)) {
      setLoading(false);
      if (form.srcNotes !== null) setSearchForm({ srcNotes: null });
      return;
    }
    let alive = true;
    const mine = ++seq.current;
    setLoading(true);
    searchSrcNotes(query, limit)
      .then((r) => {
        if (alive && mine === seq.current) setSearchForm({ srcNotes: r });
      })
      .catch(() => {
        // 源码包索引不可用（没有 NC home / 命令失败）不该让搜索页报错
        if (alive && mine === seq.current) setSearchForm({ srcNotes: null });
      })
      .finally(() => {
        // 也要判序号：旧请求回来不能把新请求的「搜索中」收掉
        if (alive && mine === seq.current) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done, query, limit, nonce]);

  const result = form.srcNotes;
  if (!done) return null;
  // 🔴 `building` 也要渲染：索引还没建好时没有任何命中，但这时恰恰必须告诉用户
  // 「不是没做，是在建」——否则第一次用只会看到这一段凭空消失。
  // loading 同理：请求在飞时先亮个壳，别让界面像卡住了。
  if (!result && !loading) return null;
  // error 同样要渲染：索引建失败时也是 0 命中，静默消失等于把「建不起来」说成「没问题」
  if (result && !result.building && !result.error && result.items.length === 0 && !loading) {
    return null;
  }
  const building = result?.building === true;
  const failed = result?.error ?? "";
  const shown = result?.items.length ?? 0;
  const total = result?.total ?? 0;
  // 截断分两种：limit 截断（还能往上提）与扫描超预算（total 只是下限，提 limit 也没用）
  const moreByLimit = shown < total;
  const nextLimit = Math.min(limit * 2, JAR_SEARCH_MAX_LIMIT);
  const canLoadMore = moreByLimit && limit < JAR_SEARCH_MAX_LIMIT;

  return (
    <section className="flex-shrink-0 border-b border-border" aria-label="依赖 jar 内的源码注释">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 bg-muted/40 px-3 py-1 text-[12px]">
        <Icon name="package" size={13} className="flex-shrink-0 text-muted-foreground" />
        <span className="font-semibold">jar 内源码注释</span>
        {loading ? (
          <span className="text-muted-foreground">搜索中…</span>
        ) : (
          // building 时不说命中数：索引还没建好，这次没有任何命中可言，
          // 报个上次的条数只会让人以为库里没注释。建失败同理：那是 0 命中。
          !building && !failed && (
            <span className="text-muted-foreground">
              命中 <b>{result?.total ?? 0}</b> 条
              {result !== null && result.items.length < result.total &&
                ` · 显示前 ${result.items.length}`}
              {` · ${result?.elapsedMs ?? 0}ms`}
            </span>
          )
        )}
        <span className="flex-1" />
        {!loading && result?.stale && (
          <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[11px] text-warning-ink">
            源码包已变动，正在后台重建，以下来自旧索引
          </span>
        )}
        {!loading && result?.truncated && (
          <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[11px] text-warning-ink">
            扫描到上限，结果可能不全
          </span>
        )}
      </div>

      {/* ── 常驻说明：说清这段与上一段的分工 ──
          编译产物里没有注释，所以「搜注释」只能走源码包。不写这一行，
          用户会奇怪为什么同一个词在两段里的命中不一样。 */}
      <p className="border-b border-border px-3 py-1 text-[11px] leading-relaxed text-muted-foreground">
        来自 NC 随包发布的 <span className="font-mono">_src.jar</span> 源码。
        class 文件不含注释，所以这段是 jar 内注释的唯一来源；点开是原始源码。
      </p>

      {loading ? (
        <div className="px-3 py-2 text-[11.5px] text-muted-foreground">搜索中…</div>
      ) : failed ? (
        // 建失败不能继续演「正在后台建立」：那是永远等不到的假进度，用户会一直等
        <div className="px-3 py-2 text-[11.5px] text-destructive-ink">
          源码注释索引建立失败：{failed}
          。建索引要重读全部源码包里的 .java，磁盘满或杀软占用索引文件时会这样；
          清出空间、或把 NC home 加进杀软白名单后重启应用再试。
        </div>
      ) : building ? (
        <div className="px-3 py-2 text-[11.5px] text-muted-foreground">
          源码注释索引正在后台建立（首次要读一遍全部源码包里的 .java），
          建完这段就会出现结果。
        </div>
      ) : (
        <ul className="max-h-64 overflow-auto">
          {(result?.items ?? []).map((hit) => {
            const jarName = hit.jar.split(/[\\/]/).pop() ?? hit.jar;
            const className = srcNoteClass(hit.path);
            return (
              <li key={`${hit.jar}:${hit.path}:${hit.line}`}>
                <button
                  type="button"
                  onClick={() => onOpenSource(hit.jar, className, hit.line)}
                  title={`${hit.jar}\n${hit.path}:${hit.line}\n点开查看源码`}
                  className="flex w-full items-center gap-2 px-3 py-1 text-left text-[12px] hover:bg-accent"
                >
                  <span className="w-10 shrink-0 text-right font-mono text-[11px] text-muted-foreground/70">
                    {hit.line}
                  </span>
                  <span className="min-w-0 flex-1 truncate" title={hit.text}>
                    {hit.text}
                  </span>
                  <span className="ml-auto shrink-0 truncate text-[11px] text-muted-foreground/70" title={hit.path}>
                    {className}
                  </span>
                  <span className="shrink-0 truncate text-[11px] text-muted-foreground/70" title={hit.jar}>
                    {jarName}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {/* 加载更多：只对 limit 截断有意义（扫描超预算时提 limit 也是这批，
          那时的出路是细化关键词，所以按钮在顶到后端上限后就消失）。 */}
      {!loading && !failed && !building && canLoadMore && (
        <div className="border-t border-border px-3 py-1.5">
          <button
            type="button"
            onClick={() => setReload({ query, limit: nextLimit, nonce: nonce + 1 })}
            className="text-[11.5px] text-primary hover:underline"
          >
            加载更多（还有 {total - shown} 条，最多到 {JAR_SEARCH_MAX_LIMIT} 条）
          </button>
        </div>
      )}
    </section>
  );
}
