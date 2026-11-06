import type { BmfDraftPreview, BmfEditOp } from "./bmf";

export interface MetaDraftStep { id: string; label: string; ops: BmfEditOp[] }
export interface MetaDraft {
  baseSha: string | null; steps: MetaDraftStep[]; redo: MetaDraftStep[];
  preview: BmfDraftPreview | null; reviewedSha: string | null; busy: boolean; error: string | null;
}
export type MetaStage = (label: string, ops: BmfEditOp[]) => Promise<boolean>;
export const MAX_DRAFT_STEPS = 500;
export const MAX_DRAFT_OPS = 10_000;
export const newMetaDraft = (): MetaDraft => ({ baseSha: null, steps: [], redo: [], preview: null, reviewedSha: null, busy: false, error: null });
export const draftOps = (steps: MetaDraftStep[]) => steps.flatMap((step) => step.ops);

/** 每一步只生成一次 ID；撤销、重做、预览及保存共享它。 */
export function stableDraftOps(ops: BmfEditOp[]): BmfEditOp[] {
  return ops.map((op) => {
    if (op.op === "addEntity") return { ...op, id: op.id || crypto.randomUUID(), attrs: op.attrs?.map((a) => ({ ...a, id: a.id || crypto.randomUUID() })) };
    if (["addAttribute", "addEnumItem", "addEnum", "addRelation"].includes(op.op)) return { ...op, id: (op as { id?: string }).id || crypto.randomUUID() } as BmfEditOp;
    return { ...op };
  });
}

export function checkDraftSize(steps: MetaDraftStep[]) {
  if (steps.length > MAX_DRAFT_STEPS || draftOps(steps).length > MAX_DRAFT_OPS) throw new Error(`草稿最多 ${MAX_DRAFT_STEPS} 步、${MAX_DRAFT_OPS} 个操作，请先保存当前批次`);
}

export const definitionStamps = (preview: BmfDraftPreview) => Object.fromEntries((preview.detail.interfaces ?? []).filter((i) => i.external).map((i) => [i.id, i.definitionSha]));
export const draftChanged = (draft: MetaDraft) => draft.steps.length > 0;
