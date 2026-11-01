import { useState } from "react";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Dialog } from "../ui/dialog";
import { Spinner } from "../ui/Spinner";
import { replaceWorkspace, type SearchOptions } from "../../lib/search";
import { previewReplacedLine, replacePlan } from "../../lib/replacePreview";
import type { SearchForm } from "../../lib/searchStore";

type Phase = "confirm" | "running" | "done";

/**
 * 「全部替换」入口 + 确认框（全局搜索页）。
 *
 * 三条设计纪律（都是同类工具用事故换来的）：
 * 1. **替换前必须确认，且确认框要说清「直接改磁盘」**：结果不经编辑器、不进撤销历史，
 *    误操作只能靠 SVN 还原。VS Code 的替换确认框被跳过太多次，IDEA 则是 Preview 后
 *    还要点一次 Replace——这里取中间：一次确认 + 列出预计改动面。
 * 2. **跑起来就不能取消**：后端没有替换的取消位，中途停下 = 改了一半，比多等一会儿
 *    难查得多。所以 running 阶段遮罩/Esc/关闭全部失效，只显示进度文案。
 * 3. **改完必须提醒「搜索结果过期了」**：磁盘变了屏幕没变，不提示的话用户会拿旧结果
 *    继续判断。不自动重搜（又一次全盘扫描，0.6~20s），把「重新搜索」摆出来让人点。
 */
export function ReplaceBar({
  form,
  update,
  options,
  onReSearch,
  stale,
}: {
  form: SearchForm;
  update: (patch: Partial<SearchForm>) => void;
  /** 当前搜索条件（SearchTab 从 form 现算，保证替换范围与搜索结果一致）。 */
  options: SearchOptions;
  onReSearch: () => void;
  /**
   * 搜索结果属于别的工作区。这时禁止替换：确认框里列的改动面是旧工作区的，
   * 而后端按**当前**工作区执行——照着旧面确认，改的是新工作区的文件。
   */
  stale: boolean;
}) {
  const hits = form.outcome?.hits ?? [];
  const plan = replacePlan(hits);
  /**
   * 结果对应的条件快照。没有快照（旧状态）或与当前表单不一致时一律不许替换：
   * 确认框列的是旧结果的改动面，后端却按新条件全盘改写——不可撤销的错配。
   */
  const snapshot = form.outcomeOptions;
  const criteriaStale = !snapshot || !sameCriteria(snapshot, options);
  const shownQuery = snapshot?.text ?? form.query;
  const scopeBlocked = stale || criteriaStale;
  // 惰性初值：替换在跑时切走再回来，直接进入 running——不能让人再点一次「替换」
  const [phase, setPhase] = useState<Phase>(() => (form.replacing ? "running" : "confirm"));
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (hits.length === 0 && !form.replaceOutcome) return null;

  const close = () => {
    setOpen(false);
    setError(null);
  };

  const run = async () => {
    if (scopeBlocked || !snapshot) return;
    update({ replacing: true, replaceOutcome: null });
    setPhase("running");
    try {
      // 用结果对应的快照执行，而不是表单实时值：两者不一致时界面上已经禁用了按钮
      const out = await replaceWorkspace(snapshot, form.replacement);
      update({ replacing: false, replaceOutcome: out });
      setPhase("done");
    } catch (e) {
      // 失败时把原因留在框里（弹 toast 会被模态遮罩盖住，也可能被忽略）
      update({ replacing: false });
      setError(String(e));
      setPhase("confirm");
    }
  };

  const deleting = form.replacement === "";

  return (
    <>
      <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-1.5">
        <span className="text-[11.5px] text-muted-foreground">替换为</span>
        <input
          value={form.replacement}
          onChange={(e) => update({ replacement: e.target.value })}
          placeholder="留空 = 删除"
          spellCheck={false}
          disabled={form.replacing}
          className="h-7 w-52 rounded-md border border-input bg-background px-2 text-[12px] outline-none placeholder:text-muted-foreground focus:border-ring disabled:opacity-50"
        />
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          disabled={hits.length === 0 || form.replacing || scopeBlocked}
          isLoading={form.replacing}
          loadingText="替换中"
          onClick={() => {
            setError(null);
            setPhase("confirm");
            setOpen(true);
          }}
        >
          全部替换…
        </Button>
        {form.replaceOutcome && !open && (
          <button
            type="button"
            onClick={() => {
              setPhase("done");
              setOpen(true);
            }}
            title="查看上次替换的结果"
            className="flex items-center gap-1 rounded bg-warning/15 px-1.5 py-0.5 text-[11px] text-warning-ink hover:bg-warning/25"
          >
            <Icon name="alertTriangle" size={12} />
            上次替换改写了 {form.replaceOutcome.filesChanged} 个文件 · 搜索结果已过期
          </button>
        )}
      </div>

      <Dialog
        open={open}
        onClose={() => {
          // running 阶段不给任何关闭途径（见文件头纪律 2）
          if (phase !== "running") close();
        }}
      >
        <div className="flex items-center gap-2">
          <Icon name="alertTriangle" size={17} className="text-destructive-ink" />
          <h3 className="text-base font-semibold">全部替换</h3>
        </div>

        {phase === "confirm" && (
          <>
            <p className="mt-2 text-sm text-muted-foreground">
              把 <b className="text-foreground">「{shownQuery.trim() || "（空）"}」</b>
              {deleting ? "（全部删除）" : <>替换为 <b className="text-foreground">「{form.replacement}」</b></>}
              ，预计涉及 <b className="text-foreground">{plan.files}</b> 个文件、
              <b className="text-foreground">{plan.hits}</b> 处。
            </p>

            <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] leading-relaxed">
              <b className="text-destructive-ink">这会直接改写磁盘上的文件</b>
              ：不经过编辑器、不进撤销历史，误操作只能靠 SVN 还原。
              混合换行、或编码无法无损往返的文件会被跳过（结束后报数，不会硬改）。
              {form.outcome?.truncated && (
                <>当前搜索结果已到上限，实际改动可能比上面更多。</>
              )}
            </div>

            {stale && (
              <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] leading-relaxed">
                <b className="text-destructive-ink">工作区已变更</b>
                ：这些搜索结果属于上一个工作区，上面列的改动面也是它的。
                后端按**当前**工作区执行替换——照着旧清单确认，改的就是新工作区的文件。
                请取消，重新搜索后再替换。
              </div>
            )}

            {criteriaStale && !stale && (
              <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] leading-relaxed">
                <b className="text-destructive-ink">搜索条件已改</b>
                ：上面列的是上一次搜索「{shownQuery.trim() || "（空）"}」的改动面，
                与当前输入框里的条件不一致。请取消，重新搜索后再替换——否则改的是另一批文件。
              </div>
            )}

            {plan.top.length > 0 && (
              <div className="mt-3 max-h-32 overflow-auto rounded-lg border border-border px-3 py-2 text-[12px]">
                {plan.top.map((f) => (
                  <div key={f.path} className="flex items-center gap-2 py-0.5">
                    <Icon name="file" size={12} className="flex-shrink-0 text-primary" />
                    <span className="truncate font-mono">{f.path}</span>
                    <span className="ml-auto flex-shrink-0 text-muted-foreground">{f.count} 处</span>
                  </div>
                ))}
                {plan.rest > 0 && (
                  <div className="py-0.5 text-muted-foreground">…以及其他 {plan.rest} 个文件</div>
                )}
              </div>
            )}

            {!form.regex && hits.length > 0 && (
              <div className="mt-3 rounded-lg bg-muted px-3 py-2 font-mono text-[11.5px] leading-relaxed">
                <div className="text-muted-foreground line-through">{hits[0].text}</div>
                <div className="mt-0.5 break-all">
                  {previewReplacedLine(hits[0].text, hits[0].ranges, form.replacement)}
                </div>
              </div>
            )}
            {form.regex && (
              <div className="mt-2 text-[11.5px] text-muted-foreground">
                正则模式下 $1 之类的分组引用由后端展开，这里不预览改后效果。
              </div>
            )}

            {error && (
              <div className="mt-3 flex items-start gap-1.5 text-[12px] text-destructive-ink">
                <Icon name="alertTriangle" size={13} className="mt-px flex-shrink-0" />
                <span className="break-all">{error}</span>
              </div>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={close}>
                取消
              </Button>
              <Button variant="destructive" size="sm" disabled={scopeBlocked} onClick={() => void run()}>
                {deleting ? "确认删除" : "确认替换"}
              </Button>
            </div>
          </>
        )}

        {phase === "running" && (
          <div className="py-6">
            <div className="flex items-center justify-center gap-2 text-sm">
              <Spinner size={16} />
              正在替换…（与搜索同样的扫描范围）
            </div>
            <p className="mt-2 text-center text-[11.5px] text-muted-foreground">
              写盘期间不能中断：改一半比多等一会儿难查得多。机械盘上可能要几十秒。
            </p>
          </div>
        )}

        {phase === "done" && form.replaceOutcome && (
          <>
            <p className="mt-2 text-sm">
              改写 <b>{form.replaceOutcome.filesChanged}</b> 个文件、共
              <b>{form.replaceOutcome.replacements}</b> 处
              （扫描 {form.replaceOutcome.filesScanned} 个文件，
              {(form.replaceOutcome.elapsedMs / 1000).toFixed(1)}s）。
            </p>
            {form.replaceOutcome.skippedUnsafe > 0 && (
              <p className="mt-1.5 text-[12px] text-warning-ink">
                跳过 {form.replaceOutcome.skippedUnsafe} 个文件：混合换行或编码无法无损往返，
                没有硬改。需要改这些文件请手动处理。
              </p>
            )}
            {form.replaceOutcome.truncated && (
              <p className="mt-1.5 text-[12px] text-warning-ink">
                到了时间预算提前停了：没改到的文件不代表没有匹配，请重新搜索确认。
              </p>
            )}
            {form.replaceOutcome.errors.length > 0 && (
              <div className="mt-2 max-h-28 overflow-auto rounded-lg border border-destructive/30 px-3 py-2 text-[11.5px] leading-relaxed">
                {form.replaceOutcome.errors.map((e) => (
                  <div key={e} className="break-all">
                    {e}
                  </div>
                ))}
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={close}>
                完成
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  close();
                  onReSearch();
                }}
              >
                重新搜索
              </Button>
            </div>
          </>
        )}
      </Dialog>
    </>
  );
}

/** 两份搜索条件是否等价（缺省值与显式 false 视为同一件事）。 */
function sameCriteria(a: SearchOptions, b: SearchOptions): boolean {
  return (
    a.text === b.text &&
    (a.caseSensitive ?? false) === (b.caseSensitive ?? false) &&
    (a.wholeWord ?? false) === (b.wholeWord ?? false) &&
    (a.regex ?? false) === (b.regex ?? false) &&
    (a.include ?? "") === (b.include ?? "")
  );
}
