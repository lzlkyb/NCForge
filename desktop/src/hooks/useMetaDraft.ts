import { useRef } from "react";
import { bmfDraftPreview, bmfEditSave, type BmfDetail } from "../lib/bmf";
import { checkDraftSize, definitionStamps, draftOps, newMetaDraft, stableDraftOps, type MetaDraft, type MetaDraftStep, type MetaStage } from "../lib/metaDraft";
import { toast } from "../components/ui/toast";

/** 回调捕获文档实例，结果只回到发起文档；关闭后重开同一路径也不会串入旧草稿。 */
export function useMetaDraft({ base, draft, onChange, onSaved, onDiscard }: {
  base: BmfDetail | null; draft: MetaDraft; onChange: (draft: MetaDraft) => boolean;
  onSaved: (detail: BmfDetail) => void; onDiscard: () => void;
}) {
  const current = useRef({ base, draft, onChange, onSaved, onDiscard });
  current.current = { base, draft, onChange, onSaved, onDiscard };
  const flight = useRef(false);

  const calculate = async (steps: MetaDraftStep[], redo: MetaDraftStep[], review = false) => {
    if (flight.current) throw new Error("草稿正在处理，请稍候");
    checkDraftSize(steps);
    const start = current.current;
    if (!start.base) throw new Error("请先打开一个可解析的组件");
    const previous = start.draft;
    const baseSha = previous.baseSha ?? start.base.sha256;
    if (previous.baseSha && start.base.sha256 !== previous.baseSha) throw new Error("文件已被外部修改，草稿已保留；请核对后放弃草稿或重新加载");
    if (!start.onChange({ ...previous, busy: true, error: null })) return null;
    flight.current = true;
    try {
      const preview = await bmfDraftPreview(start.base.path, draftOps(steps), baseSha);
      const next = { ...previous, baseSha: steps.length ? baseSha : null, steps, redo, preview: steps.length ? preview : null,
        reviewedSha: review ? preview.detail.sha256 : null, busy: false, error: null };
      if (!start.onChange(next)) throw new Error("草稿缓存已达上限，请先保存或关闭其它草稿文档");
      return preview;
    } catch (error) {
      start.onChange({ ...previous, busy: false, error: String(error), reviewedSha: null });
      throw error;
    } finally { flight.current = false; }
  };

  const stage: MetaStage = async (label, ops) => {
    if (!ops.length) return true;
    const step = { id: crypto.randomUUID(), label, ops: stableDraftOps(ops) };
    return !!await calculate([...current.current.draft.steps, step], []);
  };
  const attempt = async (run: () => Promise<unknown>) => {
    const start = current.current;
    try { await run(); return true; } catch (error) {
      start.onChange({ ...start.draft, busy: false, error: String(error), reviewedSha: null });
      return false;
    }
  };
  const undo = () => attempt(async () => {
    const latest = current.current.draft;
    const last = latest.steps[latest.steps.length - 1];
    if (last) await calculate(latest.steps.slice(0, -1), [...latest.redo, last]);
  });
  const redo = () => attempt(async () => {
    const latest = current.current.draft;
    const last = latest.redo[latest.redo.length - 1];
    if (last) await calculate([...latest.steps, last], latest.redo.slice(0, -1));
  });
  const review = () => attempt(async () => {
    if (!await calculate(current.current.draft.steps, current.current.draft.redo, true)) throw new Error("文档已关闭");
  });
  const discard = () => {
    if (flight.current) return;
    const start = current.current;
    if (start.onChange(newMetaDraft())) start.onDiscard();
  };
  const save = () => attempt(async () => {
    const start = current.current;
    const ready = start.draft.preview;
    if (!start.base || !ready || start.draft.reviewedSha !== ready.detail.sha256 || !start.draft.steps.length || flight.current) throw new Error("请先预览当前草稿");
    if (ready.blockingIssues?.length) throw new Error("草稿新增校验错误，请修正后保存");
    if (!start.onChange({ ...start.draft, busy: true, error: null })) throw new Error("文档已关闭");
    flight.current = true;
    try {
      const fresh = await bmfDraftPreview(start.base.path, draftOps(start.draft.steps), ready.baseSha);
      if (fresh.detail.sha256 !== ready.detail.sha256 || JSON.stringify(definitionStamps(fresh)) !== JSON.stringify(definitionStamps(ready))) {
        throw new Error("文件或接口定义已变化，请重新预览草稿后保存");
      }
      const result = await bmfEditSave(start.base.path, fresh.ops, fresh.baseSha, definitionStamps(fresh));
      start.onSaved(fresh.detail);
      toast(result.changed ? "草稿已保存，原文件已备份" : "草稿与文件一致", "success");
    } finally { flight.current = false; }
  });
  return { stage, undo, redo, review, discard, save };
}
