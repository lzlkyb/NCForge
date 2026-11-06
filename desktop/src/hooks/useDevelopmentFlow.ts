import { useEffect, useRef } from "react";
import { useSessionStore } from "../lib/sessionStore";
import { useWorkspaceSelector } from "../lib/workspaceSession";
import { cancelDevelopmentFlow, developmentFlowStore, dismissDevelopmentResult, runDevelopmentFlow, subscribeDevelopmentChanged } from "../lib/developmentFlowSession";
import { readDevelopmentOptions, saveDevelopmentOptions } from "../lib/developmentFlowPrefs";
import type { DevelopmentOptions } from "../lib/developmentFlow";

export function useDevelopmentFlow(onChanged?: () => void, compileAll?: () => Promise<boolean>) {
  const root = useWorkspaceSelector((s) => s.root);
  const snapshot = useSessionStore(developmentFlowStore);
  const callbacks = useRef({ onChanged, compileAll }); callbacks.current = { onChanged, compileAll };
  useEffect(() => subscribeDevelopmentChanged(() => callbacks.current.onChanged?.()), []);
  const config = readDevelopmentOptions(root);
  const save = (options: DevelopmentOptions) => {
    if (!root) throw new Error("先打开工程再保存开发流程");
    saveDevelopmentOptions(root, options);
    developmentFlowStore.set({ prefsVersion: developmentFlowStore.get().prefsVersion + 1 });
  };
  return {
    root, config, snapshot,
    running: snapshot.state === "running" || snapshot.state === "cancelling",
    start: (options = config) => runDevelopmentFlow(options, callbacks.current.compileAll),
    cancel: () => cancelDevelopmentFlow(), save, dismiss: dismissDevelopmentResult,
  };
}
