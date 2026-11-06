import { useCallback, useEffect, useReducer, useRef } from "react";
import { bmfGenApply, bmfGenDiff, bmfGeneratePlan, bmfValidate, type BmfArtifactStatus, type BmfGenApply, type BmfGenPlan, type BmfGenProfile, type BmfIssue } from "../lib/bmf";
import { pickFolder, pickFolderError } from "../lib/folderPicker";
import { toast } from "../components/ui/toast";

interface GenerationState {
  profile: BmfGenProfile | null; plan: BmfGenPlan | null; issues: BmfIssue[] | null;
  statuses: Record<string, BmfArtifactStatus>; root: string; force: boolean;
  busy: boolean; applying: boolean; err: string | null; diffErr: string | null;
  diffMs: number | null; result: BmfGenApply | null;
}
const initialState = (path: string): GenerationState => ({
  profile: null, plan: null, issues: null, statuses: {}, root: `${path.replace(/[\\/][^\\/]+$/, "")}\\gen`,
  force: false, busy: false, applying: false, err: null, diffErr: null, diffMs: null, result: null,
});

/** 产物加载/漂移/写入各有令牌；工具被切走后，旧结果不能再次驱动界面或后续写入。 */
export function useMetaGeneration(path: string) {
  const [state, dispatch] = useReducer((s: GenerationState, patch: Partial<GenerationState>) => ({ ...s, ...patch }), path, initialState);
  const latest = useRef(state);
  latest.current = state;
  const requests = useRef({ plan: 0, diff: 0, write: 0 });
  const generate = useCallback(async (profile: BmfGenProfile | null) => {
    const token = ++requests.current.plan;
    requests.current.diff++;
    dispatch({ busy: true, err: null, result: null, profile });
    try {
      const [plan, issues] = await Promise.all([bmfGeneratePlan(path, profile), bmfValidate(path).catch(() => null)]);
      if (token !== requests.current.plan) return;
      dispatch({ plan, issues, profile: plan.profile, busy: false });
    } catch (e) {
      if (token === requests.current.plan) dispatch({ plan: null, profile, statuses: {}, issues: null, busy: false, err: String(e) });
    }
  }, [path]);
  useEffect(() => {
    const pending = requests.current;
    void generate(null);
    return () => { pending.plan++; pending.diff++; pending.write++; };
  }, [generate]);
  const refreshDiff = useCallback(async (plan: BmfGenPlan, root: string) => {
    const token = ++requests.current.diff;
    if (!root.trim()) { dispatch({ statuses: {}, diffMs: null, diffErr: null }); return; }
    dispatch({ diffErr: null });
    try {
      const diff = await bmfGenDiff(path, plan.profile, undefined, root.trim());
      if (token === requests.current.diff) dispatch({ statuses: Object.fromEntries(diff.items.map((item) => [item.id, item])), diffMs: diff.timings.diffMs });
    } catch (e) {
      if (token === requests.current.diff) dispatch({ statuses: {}, diffMs: null, diffErr: String(e) });
    }
  }, [path]);
  useEffect(() => { if (state.plan && !state.busy) void refreshDiff(state.plan, state.root); }, [state.plan, state.root, state.busy, refreshDiff]);
  const pick = async () => {
    const token = requests.current.plan;
    try {
      const root = await pickFolder({ title: "选择生成物落盘目录", defaultPath: latest.current.root || undefined });
      if (root && token === requests.current.plan) dispatch({ root });
    } catch (e) { if (token === requests.current.plan) dispatch({ err: pickFolderError(e) }); }
  };
  const apply = async (selected: Set<string>) => {
    const { plan, profile, root, force, issues, busy, applying } = latest.current;
    if (!plan || !profile || busy || applying) return;
    if (issues === null) { dispatch({ err: "规则校验未完成，请重新生成后再落盘" }); return; }
    if (issues?.some((issue) => issue.severity === "error")) { dispatch({ err: "存在校验错误，先修复再落盘" }); return; }
    if (!root.trim()) { dispatch({ err: "请先选择落盘目录" }); return; }
    const token = ++requests.current.write;
    dispatch({ applying: true, err: null });
    try {
      const result = await bmfGenApply(path, profile, undefined, root.trim(), [...selected], force);
      if (token !== requests.current.write) return;
      dispatch({ result });
      toast(result.written > 0 ? `已写入 ${result.written} 个文件` : "没有需要写入的文件", result.written > 0 ? "success" : "info");
      if (latest.current.plan === plan && latest.current.root === root) await refreshDiff(plan, root);
    } catch (e) { if (token === requests.current.write) dispatch({ result: null, err: String(e) }); }
    finally { if (token === requests.current.write) dispatch({ applying: false }); }
  };
  return { ...state, generate, pick, apply, setRoot: (root: string) => dispatch({ root }), setForce: (force: boolean) => dispatch({ force }) };
}
