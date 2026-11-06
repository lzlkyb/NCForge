import { useCallback, useEffect, useReducer, useRef } from "react";
import type { BmfArtifactStatus, BmfGenPlan, BmfIssue, BmfGenProfile } from "../lib/bmf";
import { generationApply, generationCheck, generationPreview, newGenerationPreferences,
  type GenerationPreferences, type GenerationSnapshot, type GenerationResult } from "../lib/bmfGeneration";
import { generationCounts, reconcileGeneration } from "../lib/metaGeneration";
import { pickFolder, pickFolderError } from "../lib/folderPicker";
import { toast } from "../components/ui/toast";

interface GenerationState {
  prefs: GenerationPreferences; plan: BmfGenPlan | null; issues: BmfIssue[] | null;
  description: GenerationSnapshot | null; snapshot: GenerationSnapshot | null;
  statuses: Record<string, BmfArtifactStatus>; checkedRoot: string | null;
  busy: boolean; checking: boolean; applying: boolean; err: string | null; diffErr: string | null;
  diffMs: number | null; result: GenerationResult | null;
}
const initialState = (prefs: GenerationPreferences): GenerationState => ({
  prefs, plan: null, issues: null, description: null, snapshot: null, statuses: {}, checkedRoot: null,
  busy: false, checking: false, applying: false, err: null, diffErr: null, diffMs: null, result: null,
});
const fingerprint = (profile: BmfGenProfile | null) => JSON.stringify(profile);

/** 每类请求有版本；配置输入保持草稿，写入只使用已校验且与目录绑定的预览。 */
export function useMetaGeneration(path: string, preferences?: GenerationPreferences, sourceSha?: string,
  onPreferences?: (prefs: GenerationPreferences) => void) {
  const [state, dispatch] = useReducer((s: GenerationState, patch: Partial<GenerationState>) => ({ ...s, ...patch }), preferences ?? newGenerationPreferences(path), initialState);
  const latest = useRef(state);
  const persist = useRef(onPreferences);
  persist.current = onPreferences;
  const requests = useRef({ plan: 0, check: 0, write: 0, mounted: true });
  const queuedPreview = useRef<(() => Promise<void>) | null>(null);
  const patch = useCallback((next: Partial<GenerationState>, render = true) => {
    latest.current = { ...latest.current, ...next };
    if (next.prefs) persist.current?.(next.prefs);
    if (render) dispatch(next);
  }, []);
  const setPreferences = useCallback((next: Partial<GenerationPreferences>, render = true) => {
    if (latest.current.applying) return;
    const prefs = { ...latest.current.prefs, ...next };
    if (next.profile !== undefined || next.root !== undefined) prefs.overrides = [];
    const rootChanged = prefs.root.trim() !== latest.current.prefs.root.trim();
    if (rootChanged) requests.current.check++;
    patch({ prefs, ...(rootChanged ? { snapshot: null, checkedRoot: null, checking: true, diffErr: null } : {}) }, render);
  }, [patch]);

  const check = useCallback(async (description = latest.current.description, root = latest.current.prefs.root) => {
    if (!description || !requests.current.mounted || latest.current.busy) return;
    const token = ++requests.current.check;
    const before = latest.current.snapshot;
    patch({ checking: true, snapshot: null, diffErr: null });
    try {
      const result = await generationCheck(description, root.trim());
      if (token !== requests.current.check || !requests.current.mounted) return;
      // 覆盖授权只跟随已核对的目标版本，不能沿用到外部改动或重定向后的文件。
      const overrides = latest.current.prefs.overrides.filter((id) => {
        const approved = before?.targets.find((t) => t.id === id);
        const checked = result.snapshot?.targets.find((t) => t.id === id);
        return !!approved && !!checked && JSON.stringify(approved) === JSON.stringify(checked);
      });
      patch({ snapshot: result.snapshot, statuses: Object.fromEntries(result.items.map((s) => [s.id, s])),
        prefs: { ...latest.current.prefs, overrides },
        checkedRoot: root.trim(), diffErr: result.error, diffMs: result.timings.diffMs, checking: false });
    } catch (e) {
      if (token === requests.current.check && requests.current.mounted) patch({ snapshot: null, statuses: {},
        prefs: { ...latest.current.prefs, overrides: [] },
        checkedRoot: root.trim(), checking: false, diffMs: null, diffErr: String(e) });
    }
  }, [patch]);
  const generate = useCallback(async (profile = latest.current.prefs.profile, preserveWriteFeedback = false) => {
    if (latest.current.applying) return;
    const token = ++requests.current.plan;
    requests.current.check++;
    const root = latest.current.prefs.root;
    patch({ busy: true, checking: false, snapshot: null, diffErr: null,
      ...(!preserveWriteFeedback ? { err: null, result: null } : {}) });
    try {
      const preview = await generationPreview(path, profile, root.trim());
      if (token !== requests.current.plan || !requests.current.mounted) return;
      const prefs = latest.current.prefs;
      const nextPrefs = { ...prefs, ...reconcileGeneration(preview.plan, prefs, latest.current.plan),
        profile: fingerprint(prefs.profile) === fingerprint(profile) ? preview.plan.profile : prefs.profile, overrides: [] };
      const sameRoot = prefs.root.trim() === root.trim();
      patch({ plan: preview.plan, description: preview.description, issues: preview.issues,
        prefs: nextPrefs, busy: false,
        snapshot: sameRoot ? preview.check.snapshot : null,
        statuses: sameRoot ? Object.fromEntries(preview.check.items.map((s) => [s.id, s])) : {},
        checkedRoot: sameRoot ? root.trim() : null, diffErr: sameRoot ? preview.check.error : null,
        diffMs: sameRoot ? preview.check.timings.diffMs : null });
    } catch (e) {
      if (token === requests.current.plan && requests.current.mounted) patch({ busy: false, plan: null,
        snapshot: null, description: null, issues: null, statuses: {}, err: String(e) });
    }
  }, [path, patch]);
  useEffect(() => {
    const pending = requests.current;
    pending.mounted = true;
    return () => { pending.mounted = false; pending.plan++; pending.check++; pending.write++; queuedPreview.current = null; };
  }, []);
  useEffect(() => {
    requests.current.plan++; requests.current.check++;
    // 源刷新只撤销预览；正在执行的写入仍须返回真实结果，再刷新最新源。
    if (latest.current.applying) {
      queuedPreview.current = () => generate(undefined, true);
      patch({ snapshot: null, checkedRoot: null, checking: false });
      return;
    }
    queuedPreview.current = null;
    void generate();
  }, [generate, sourceSha, patch]);
  useEffect(() => {
    if (!state.description || state.busy || state.applying || latest.current.checkedRoot === state.prefs.root.trim()) return;
    const timer = setTimeout(() => void check(), 300);
    return () => clearTimeout(timer);
  }, [state.description, state.prefs.root, state.busy, state.applying, check]);

  const pick = async () => {
    const token = requests.current.plan;
    try {
      const root = await pickFolder({ title: "选择生成产物输出目录", defaultPath: latest.current.prefs.root || undefined });
      if (root && requests.current.mounted && token === requests.current.plan) setPreferences({ root });
    } catch (e) { if (requests.current.mounted) patch({ err: pickFolderError(e) }); }
  };
  const readiness = (s: GenerationState) => {
    if (s.busy) return "正在更新产物";
    if (!s.plan || !s.prefs.profile || s.issues === null) return "请先完成生成预览与规则校验";
    if (fingerprint(s.prefs.profile) !== fingerprint(s.plan.profile)) return "配置已修改，请更新产物";
    if (s.issues.some((i) => i.severity === "error")) return "存在校验错误，请返回元数据修复";
    if (s.checking) return "正在检查输出目录";
    if (s.diffErr || !s.snapshot || s.checkedRoot !== s.prefs.root.trim()) return s.diffErr || "请先检查输出目录";
    const counts = generationCounts(s.plan, s.statuses, s.prefs.selected ?? [], s.prefs.overrides);
    if (!counts.selected) return "请选择生成产物";
    if (counts.unknown) return "部分文件尚未检查，请重新检查目录";
    return counts.create + counts.update > 0 ? null : "没有需要写入的文件";
  };
  const apply = async (expected: GenerationSnapshot | null = latest.current.snapshot,
    selected = latest.current.prefs.selected ?? [], overrides = latest.current.prefs.overrides) => {
    const s = latest.current;
    if (s.applying) return false;
    const reason = readiness(s);
    if (reason || !expected || !s.plan) { patch({ err: reason || "缺少预览版本" }); return false; }
    if (JSON.stringify(expected) !== JSON.stringify(s.snapshot)) { patch({ err: "预览版本已变化，请重新确认" }); return false; }
    if (JSON.stringify(selected) !== JSON.stringify(s.prefs.selected ?? []) || JSON.stringify(overrides) !== JSON.stringify(s.prefs.overrides)) {
      patch({ err: "产物选择或覆盖决策已变化，请重新确认" }); return false;
    }
    const token = ++requests.current.write;
    patch({ applying: true, err: null });
    try {
      const result = await generationApply(path, s.plan.profile, s.prefs.root.trim(), s.prefs.selected ?? [], s.prefs.overrides, expected);
      if (token !== requests.current.write || !requests.current.mounted) return false;
      patch({ result, prefs: { ...latest.current.prefs, overrides: [] } });
      toast(result.failed || result.manifestError ? "生成写入有失败项，请查看结果" : `已写入 ${result.written} 个文件`, result.failed || result.manifestError ? "error" : "success");
      if (!queuedPreview.current) await check(s.description, s.prefs.root);
      return true;
    } catch (e) {
      if (token === requests.current.write && requests.current.mounted) patch({ err: String(e), snapshot: null,
        checkedRoot: s.prefs.root.trim(), diffErr: "写入未完成，请更新产物后重新确认" });
      return false;
    } finally {
      if (token === requests.current.write && requests.current.mounted) {
        patch({ applying: false });
        const refresh = queuedPreview.current;
        queuedPreview.current = null;
        if (refresh) await refresh();
      }
    }
  };
  return { ...state, profile: state.prefs.profile, root: state.prefs.root, generate, check, pick, apply, setPreferences,
    setRoot: (root: string) => setPreferences({ root }),
    counts: generationCounts(state.plan, state.statuses, state.prefs.selected ?? [], state.prefs.overrides),
    dirty: !!state.plan && fingerprint(state.prefs.profile) !== fingerprint(state.plan.profile),
    blockedReason: readiness(state) };
}
