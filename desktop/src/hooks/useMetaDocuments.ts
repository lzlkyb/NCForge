import { useCallback, useEffect, useRef, useState } from "react";
import { bmfDetail, bmfValidate, type BmfDetail, type BmfEntry, type BmfIssue } from "../lib/bmf";
import { normalizeBmfPath } from "../lib/bmfPath";
import { newMetaEditorState, restoreMetaSelection, type MetaEditorState } from "../lib/metaEditor";
import { draftChanged, newMetaDraft, type MetaDraft } from "../lib/metaDraft";
import { toast } from "../components/ui/toast";

export interface MetaDocument {
  key: string;
  instance: number;
  entry: BmfEntry;
  detail: BmfDetail | null;
  error: string | null;
  busy: boolean;
  issues: BmfIssue[];
  issueBusy: boolean;
  issueError: string | null;
  ui: MetaEditorState;
  draft: MetaDraft;
  usedAt: number;
}
interface Documents { active: string | null; items: MetaDocument[] }
const MAX_DETAILS = 6;
const MAX_DETAIL_BYTES = 16 * 1024 * 1024;

function trimDetails(state: Documents): Documents {
  let count = 0;
  let bytes = 0;
  const keep = new Set<string>();
  const byRecent = [...state.items].sort((a, b) => Number(b.key === state.active) - Number(a.key === state.active) || b.usedAt - a.usedAt);
  for (const doc of byRecent) {
    if (!doc.detail) continue;
    if (draftChanged(doc.draft) || doc.draft.busy || doc.key === state.active || (count < MAX_DETAILS && bytes + doc.detail.size <= MAX_DETAIL_BYTES)) {
      keep.add(doc.key);
      count++;
      bytes += doc.detail.size;
    }
  }
  return { ...state, items: state.items.map((doc) => doc.detail && !keep.has(doc.key) ? { ...doc, detail: null, issues: [] } : doc) };
}

/** 文档令牌彼此独立：保存刷新旧文档不会抢走活动文档，关闭后迟到结果也不能复活标签。 */
export function useMetaDocuments() {
  const [state, setState] = useState<Documents>({ active: null, items: [] });
  const stateRef = useRef(state);
  const tokens = useRef(new Map<string, number>());
  const serial = useRef(0);
  const mounted = useRef(true);
  const update = useCallback((fn: (prev: Documents) => Documents) => {
    stateRef.current = fn(stateRef.current);
    setState(stateRef.current);
  }, []);
  useEffect(() => {
    const pendingTokens = tokens.current;
    mounted.current = true;
    return () => { mounted.current = false; pendingTokens.clear(); };
  }, []);

  const refresh = useCallback(async (entry: BmfEntry, forceValidate = false) => {
    const key = normalizeBmfPath(entry.path);
    if (!mounted.current || !stateRef.current.items.some((d) => d.key === key)) return;
    const token = ++serial.current;
    tokens.current.set(key, token);
    const valid = () => mounted.current && tokens.current.get(key) === token;
    const patch = (fn: (doc: MetaDocument) => MetaDocument) => {
      if (valid()) update((s) => ({ ...s, items: s.items.map((d) => d.key === key ? fn(d) : d) }));
    };
    const previous = stateRef.current.items.find((d) => d.key === key)!;
    patch((d) => ({ ...d, entry, busy: true, error: null, issueError: null }));
    try {
      const detail = await bmfDetail(entry.path);
      if (!valid()) return;
      const reuseIssues = !!detail.issues || (!forceValidate && previous.detail?.sha256 === detail.sha256 && !previous.issueError && !previous.issueBusy);
      patch((d) => ({
        ...d, detail, busy: false, error: null,
        entry: { ...d.entry, name: detail.component.name, displayName: detail.component.displayName, error: null },
        ui: { ...d.ui, selection: restoreMetaSelection(d.draft.preview?.detail ?? detail, d.ui.selection) },
        draft: d.draft.baseSha && d.draft.baseSha !== detail.sha256 ? { ...d.draft, error: "文件已被外部修改；草稿已保留，请核对后处理", reviewedSha: null } : d.draft,
        issueBusy: !reuseIssues, issues: detail.issues ?? (reuseIssues ? previous.issues : []),
      }));
      if (!reuseIssues) {
        try {
          const issues = await bmfValidate(entry.path);
          patch((d) => ({ ...d, issues, issueBusy: false }));
        } catch (e) {
          patch((d) => ({ ...d, issueError: String(e), issueBusy: false }));
        }
      }
      if (valid()) update(trimDetails);
    } catch (e) {
      patch((d) => ({ ...d, detail: null, error: String(e), busy: false, issueBusy: false, issues: [] }));
    }
  }, [update]);

  const open = useCallback((entry: BmfEntry) => {
    if (!mounted.current) return false;
    const key = normalizeBmfPath(entry.path);
    const existing = stateRef.current.items.find((d) => d.key === key);
    const pinned = stateRef.current.items.filter((d) => draftChanged(d.draft) && d.key !== key);
    if (pinned.length >= MAX_DETAILS || (pinned.length > 0 && pinned.reduce((sum, d) => sum + (d.detail?.size ?? d.draft.preview?.detail.size ?? 0), entry.size) > MAX_DETAIL_BYTES)) {
      toast("草稿缓存已达上限，请先保存或关闭草稿文档，再打开这个组件", "info");
      return false;
    }
    const usedAt = ++serial.current;
    update((s) => ({ active: key, items: existing ? s.items.map((d) => d.key === key ? { ...d, usedAt } : d) : [...s.items, {
      key, instance: usedAt, entry, detail: null, error: entry.error, busy: false, issues: [],
      issueBusy: false, issueError: null, ui: newMetaEditorState(), draft: newMetaDraft(), usedAt,
    }] }));
    // 缓存立即呈现，但每次切回来仍读盘检查 SHA，避免缓存掩盖外部修改。
    if (existing || !entry.error) void refresh(entry);
    return true;
  }, [refresh, update]);

  const close = useCallback((key: string, discard = false) => {
    const closing = stateRef.current.items.find((d) => d.key === key);
    if (closing?.draft.busy || (closing && draftChanged(closing.draft) && !discard)) return false;
    tokens.current.delete(key);
    update((s) => {
      const index = s.items.findIndex((d) => d.key === key);
      const items = s.items.filter((d) => d.key !== key);
      return { items, active: s.active === key ? items[Math.max(0, index - 1)]?.key ?? null : s.active };
    });
    const active = stateRef.current.items.find((d) => d.key === stateRef.current.active);
    if (active && !active.busy) void refresh(active.entry);
    return true;
  }, [refresh, update]);

  const updateUi = useCallback((key: string, patch: Partial<MetaEditorState>, render = true) => {
    const next = (s: Documents) => ({ ...s, items: s.items.map((d) => d.key === key ? { ...d, ui: { ...d.ui, ...patch } } : d) });
    // 滚动只记到 ref；下一次选中/切换再发布，避免每一帧重绘整个资源树。
    if (render) update(next);
    else stateRef.current = next(stateRef.current);
  }, [update]);

  const updateDraft = useCallback((key: string, draft: MetaDraft, instance?: number) => {
    if (!mounted.current || !stateRef.current.items.some((d) => d.key === key && (instance == null || d.instance === instance))) return false;
    const projected = stateRef.current.items.map((d) => d.key === key ? { ...d, draft } : d);
    const dirty = projected.filter((d) => draftChanged(d.draft));
    const bytes = dirty.reduce((sum, d) => sum + (d.draft.preview?.detail.size ?? d.detail?.size ?? 0), 0);
    // 单个超大活动文件允许例外；其它草稿仍受总量与文档数限制。
    if (dirty.length > MAX_DETAILS || (dirty.length > 1 && bytes > MAX_DETAIL_BYTES)) return false;
    update((s) => ({ ...s, items: s.items.map((d) => {
      if (d.key !== key) return d;
      const detail = draft.preview?.detail ?? d.detail;
      const conflict = draft.baseSha && d.detail && draft.baseSha !== d.detail.sha256;
      const next = conflict ? { ...draft, reviewedSha: null, error: "文件已被外部修改；草稿已保留，请核对后处理" } : draft;
      return { ...d, draft: next, ui: { ...d.ui, selection: detail ? restoreMetaSelection(detail, d.ui.selection) : d.ui.selection } };
    }) }));
    return true;
  }, [update]);

  const applyDraftSaved = useCallback((key: string, detail: BmfDetail, instance?: number) => {
    if (!mounted.current || !stateRef.current.items.some((d) => d.key === key && (instance == null || d.instance === instance))) return;
    // 保存结果优先于之前发出的读盘与校验；它们不能覆盖已保存的新对象。
    tokens.current.delete(key);
    update((s) => trimDetails({ ...s, items: s.items.map((d) => d.key === key ? {
      ...d, detail, draft: newMetaDraft(), issues: detail.issues ?? [], error: null, busy: false, issueBusy: false, issueError: null,
      ui: { ...d.ui, selection: restoreMetaSelection(detail, d.ui.selection) },
    } : d) }));
  }, [update]);

  // 其它面板调整触发父级渲染时，也要读取最近记录的滚动/坐标。
  const snapshot = stateRef.current;
  return { documents: snapshot.items, active: snapshot.items.find((d) => d.key === snapshot.active) ?? null, open, close, refresh, updateUi, updateDraft, applyDraftSaved };
}
