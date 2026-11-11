import { useEffect, useState, type KeyboardEvent } from "react";
import { SvnDiffEditor } from "../svn/SvnDiffEditor";
import { svnDiff } from "../../lib/svn";
import { normalizeEol } from "../../lib/changedLines";
import { languageOfFormat } from "../../lib/fileFormats";
import { resolveRoundPair } from "../../lib/roundBaseline";
import { relativeDisplay } from "../../lib/reviewNotes";
import type { ChangeEvent } from "../../lib/changeTimeline";

interface Pair { original: string; modified: string; degraded: boolean; originalLabel: string }
/** 一轮可能几十个文件：先加载前 12 个，其余明确标「未加载」，不伪装成「无基线」。 */
const MAX_FILES = 12;

/**
 * B2 多文件 diff：左侧文件清单 + 右侧复用 `SvnDiffEditor`。
 *
 * 刻意不改造比较器内部：`SvnDiffEditor.tsx:17-24` 的 `retireModels` 要等
 * `waitForDiff()` 才释放模型（worker 并发销毁是踩过的坑），换成「容器 + 组件实例」
 * 就自动沿用那套生命周期，切文件由 React 卸载/挂载接管。
 *
 * P1-3：勾两个时间点时按 `resolveRoundPair` 取两点各自的本地历史原文，
 * 取不到就在顶部明确写「退化为 SVN 基线 / 磁盘当前内容」，不再名不副实。
 * P1-9：口径标注 + 12 个上限可解释 + Alt+↑/↓ 在文件清单里导航。
 */
export function MultiFileDiffPanel({
  paths, root, startEvent, endEvent, onBack,
}: {
  paths: string[];
  root: string;
  startEvent: ChangeEvent | null;
  endEvent?: ChangeEvent | null;
  onBack: () => void;
}) {
  const [pairs, setPairs] = useState<Record<string, Pair>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const signature = paths.join("|") + "|" + (startEvent?.id ?? "") + "|" + (endEvent?.id ?? "");

  useEffect(() => {
    let alive = true;
    // 换一批路径 / 换两个时间点：先把加载态亮出来。否则上一批的结果会继续显示，
    // 用户以为这就是新一轮的比较结果（旧代码只在首次挂载时 loading=true）。
    setLoading(true);
    void (async () => {
      const next: Record<string, Pair> = {};
      for (const p of paths.slice(0, MAX_FILES)) {
        try {
          // 先要本地历史归档点：拿到了就完全不需要碰 SVN 桥（一次 IPC + 可能起进程）。
          // 只有拿不到才退化到 svnDiff，别为每个文件都先问一遍 SVN。
          const pair = await resolveRoundPair(p, startEvent, endEvent ?? null);
          // 只有两侧都真拿到了才直接用归档：单轮比较（endEvent 为空）时
          // `resolveRoundPair` 的 modified 恒为 null，若把 null 当空串填进去，
          // 整份 diff 会显示「文件内容被删光」，而右栏标签写着「磁盘当前内容」。
          if (pair.original !== null && pair.modified !== null) {
            next[p] = {
              original: pair.original,
              modified: pair.modified,
              degraded: pair.degraded,
              originalLabel: pair.originalLabel,
            };
            continue;
          }
          const r = await svnDiff(p);
          next[p] = {
            original: pair.original ?? normalizeEol(r.baseText),
            modified: normalizeEol(r.workingText),
            degraded: pair.degraded,
            originalLabel: pair.originalLabel,
          };
        } catch {
          // 单个文件取不到基线（不在版本控制下、桥没起）跳过，不影响其他文件
        }
      }
      if (!alive) return;
      setPairs(next);
      setSelected((old) => (old && next[old] ? old : Object.keys(next)[0] ?? null));
      setLoading(false);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const usable = paths.slice(0, MAX_FILES).filter((p) => !!pairs[p]);
  const extra = Math.max(0, paths.length - MAX_FILES);
  const degraded = usable.some((p) => pairs[p].degraded);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!e.altKey || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    if (usable.length < 2) return;
    e.preventDefault();
    const at = usable.indexOf(selected ?? "");
    const delta = e.key === "ArrowDown" ? 1 : -1;
    // 还没选中任何文件时（上一批全部取不到基线）indexOf 返回 -1：
    // `(-1-1+len)%len` 会落到倒数第二个，而不是最后一个。
    if (at < 0) { setSelected(delta > 0 ? usable[0] : usable[usable.length - 1]); return; }
    setSelected(usable[(at + delta + usable.length) % usable.length]);
  };

  return (
    <div className="ncf-multi" tabIndex={0} onKeyDown={onKeyDown}>
      <div className="ncf-multi-list" role="list" aria-label="这一轮改动的文件">
        <button type="button" className="ncf-multi-back" onClick={onBack}>← 返回时间线</button>
        <div className="ncf-multi-note">
          共 {paths.length} 个文件 · 已加载前 {Math.min(paths.length, MAX_FILES)} 个（Alt+↑/↓ 切换）
        </div>
        {paths.slice(0, MAX_FILES).map((p) => (
          <button key={p} type="button" role="listitem"
            className="ncf-multi-file" data-on={selected === p || undefined}
            disabled={!pairs[p]} title={p}
            onClick={() => setSelected(p)}>
            {relativeDisplay(p, root)}
            {!pairs[p] && <span className="ncf-multi-na">未取到基线</span>}
          </button>
        ))}
        {extra > 0 && <div className="ncf-multi-note">另有 {extra} 个文件未加载（超出一次比较的上限），可在时间线里分批处理。</div>}
      </div>
      <div className="ncf-multi-body">
        <div className="ncf-multi-note">
          {endEvent ? "两点比较：A 点之前 ↔ B 点当时" : "基线 ↔ 磁盘当前内容"}；
          编辑器里未保存的 buffer 不参与比较（与代码面色条口径不同）。
          {degraded && " 部分文件没有对应归档点，已退化为 SVN 基线 / 磁盘当前内容。"}
        </div>
        {loading && <div className="ncf-empty">正在读取各文件的基线…</div>}
        {!loading && !usable.length && <div className="ncf-empty">这些文件没有可用的 SVN 基线（可能是新文件或工作副本外）。</div>}
        {!loading && selected && pairs[selected] && (
          <SvnDiffEditor
            key={selected}
            sourceKey={`${startEvent?.id ?? "base"}:${endEvent?.id ?? "now"}:${selected}`}
            root={root}
            original={pairs[selected].original}
            modified={pairs[selected].modified}
            language={languageOfFormat(selected, pairs[selected].original)}
            originalLabel={pairs[selected].originalLabel}
            modifiedLabel={endEvent ? "选中时间点当时" : "磁盘当前内容"}
          />
        )}
      </div>
    </div>
  );
}
