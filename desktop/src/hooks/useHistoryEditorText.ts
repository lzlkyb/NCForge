import { useCallback, useSyncExternalStore } from "react";
import { getModel, getText } from "../lib/editorStore";

export function useHistoryEditorText(path: string, enabled: boolean) {
  const subscribe = useCallback((listener: () => void) => {
    if (!enabled) return () => {};
    const subscription = getModel(path)?.onDidChangeContent(listener);
    return () => subscription?.dispose();
  }, [path, enabled]);
  const read = useCallback(() => enabled ? getText(path) : undefined, [path, enabled]);
  return useSyncExternalStore(subscribe, read, read);
}
