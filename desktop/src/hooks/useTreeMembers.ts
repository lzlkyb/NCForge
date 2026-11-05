import { useCallback, useEffect, useRef, useState } from "react";
import { getModel, getText, onModelLifecycle } from "../lib/editorStore";
import { javaTreeMembers, type TreeMembers } from "../lib/javaTreeMembers";
import { invoke } from "../lib/tauri";
import { dirName, baseName } from "../lib/workspace";
import type { TreeDirState } from "../lib/workspaceSession";

const EMPTY: TreeMembers = new Map();

export function useTreeMembers(enabled: boolean, dirs: Record<string, TreeDirState>) {
  const [members, setMembers] = useState<TreeMembers>(EMPTY);
  const open = useRef(new Set<string>());
  const requests = useRef(new Map<string, symbol>());
  const seenDirs = useRef(new Map<string, TreeDirState>());
  const reload = useCallback(async (path: string, showLoading = false) => {
    if (!open.current.has(path)) return;
    const request = Symbol(path);
    requests.current.set(path, request);
    if (showLoading) setMembers(prev => new Map(prev).set(path, { status: "loading", rows: [] }));
    try {
      const text = getText(path) ?? await invoke<string>("fs_java_outline_source", { path });
      if (requests.current.get(path) !== request) return;
      if (text.length > 512 * 1024) throw new Error("文件过大");
      setMembers(prev => new Map(prev).set(path, { status: "ready", rows: javaTreeMembers(path, text) }));
    } catch {
      if (requests.current.get(path) === request) setMembers(prev => new Map(prev).set(path, { status: "error", rows: [] }));
    }
  }, []);
  const close = useCallback((path: string) => {
    open.current.delete(path);
    requests.current.delete(path);
    seenDirs.current.delete(path);
    setMembers(prev => { const next = new Map(prev); next.delete(path); return next; });
  }, []);
  const toggle = (path: string) => {
    if (open.current.has(path)) { close(path); return; }
    open.current.add(path);
    void reload(path, true);
  };

  useEffect(() => {
    if (!enabled) return;
    for (const path of open.current) {
      const state = dirs[dirName(path)];
      if (state?.status !== "ok") continue;
      const previous = seenDirs.current.get(path);
      seenDirs.current.set(path, state);
      if (!state.items.some(item => !item.isDir && item.name === baseName(path))) close(path);
      else if (previous && previous !== state) void reload(path);
    }
  }, [dirs, members, close, enabled, reload]);

  const visible = enabled ? members : EMPTY;
  const signature = [...visible.keys()].join("|");
  useEffect(() => {
    if (!signature) return;
    let active = true;
    const paths = new Set(signature.split("|"));
    const subscriptions = new Map<string, { dispose(): void }>();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const detach = (path: string) => {
      subscriptions.get(path)?.dispose(); subscriptions.delete(path);
      clearTimeout(timers.get(path)); timers.delete(path);
    };
    const attach = (path: string, model: NonNullable<ReturnType<typeof getModel>>) => {
      detach(path);
      subscriptions.set(path, model.onDidChangeContent(() => {
        clearTimeout(timers.get(path));
        timers.set(path, setTimeout(() => void reload(path), 180));
      }));
    };
    const off = onModelLifecycle((path, model) => {
      if (paths.has(path)) attach(path, model);
    }, path => {
      detach(path);
      if (paths.has(path)) queueMicrotask(() => { if (active) void reload(path); });
    });
    for (const path of paths) {
      const model = getModel(path);
      if (model) attach(path, model);
    }
    return () => { active = false; off(); for (const path of paths) detach(path); };
  }, [signature, reload]);
  useEffect(() => {
    const pending = requests.current;
    return () => pending.clear();
  }, []);
  return { members: visible, toggle };
}
