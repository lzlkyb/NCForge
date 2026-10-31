import { useCallback, useEffect, useState } from "react";
import { getConfig } from "../lib/appConfig";
import {
  normalizeOverride,
  sameOverrides,
  setLinkedOverrides,
  toDraft,
  type LinkedOverride,
} from "../lib/linkedProjects";

/**
 * 覆盖表的编辑草稿。
 *
 * 后端 `set_linked_overrides` 是**全量替换**，所以界面只有「整表草稿 + 一次保存」这一种
 * 保存方式：做「单条即时保存」的话，用户刚加的另一条会被下一次保存无声冲掉。
 * `saved` 是最后一次落盘的基线，`dirty` 由两边逐条比对得出（顺序也算改动）。
 *
 * 保存后**以返回值为准**重建草稿与基线：服务端会 trim、把 `dir` 归一成 null、丢掉重复项，
 * 拿本地的期望值当真相会让界面与磁盘上的配置悄悄分叉。
 */
export function useOverrideDraft() {
  const [draft, setDraft] = useState<LinkedOverride[]>([]);
  const [saved, setSaved] = useState<LinkedOverride[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const cfg = await getConfig();
      const list = toDraft(cfg.linked_overrides);
      setDraft(list);
      setSaved(list);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 落盘并回填。失败时抛出（调用方 toast），草稿保持原样以便重试。 */
  const save = useCallback(async (list: LinkedOverride[]) => {
    setSaving(true);
    try {
      const stored = await setLinkedOverrides(list.map(normalizeOverride));
      const next = toDraft(stored);
      setDraft(next);
      setSaved(next);
      setError(null);
      return next;
    } finally {
      setSaving(false);
    }
  }, []);

  return {
    draft,
    saved,
    loaded,
    saving,
    error,
    dirty: loaded && !sameOverrides(draft, saved),
    setDraft,
    save,
    load,
  };
}
