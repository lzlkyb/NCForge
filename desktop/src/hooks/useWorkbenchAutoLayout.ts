import { useEffect, useRef } from "react";
import { useDebugSnapshot } from "../lib/debugSession";
import { useWorkspaceSelector } from "../lib/workspaceSession";
import { autoWorkbenchLayout } from "../lib/workbenchLayout";

/** Only a new completion/stop can suggest a layout; cached results never override a user's choice. */
export function useWorkbenchAutoLayout(enabled: boolean) {
  const result = useWorkspaceSelector(s => s.compileResult);
  const debug = useDebugSnapshot();
  const previousResult = useRef(result);
  const stops = useRef(new Map([[debug.target, debug.stopSeq]]));
  const paused = useRef(debug.targets);
  useEffect(() => {
    const changed = previousResult.current !== result; previousResult.current = result;
    if (enabled && changed && result && !result.ok) autoWorkbenchLayout("diagnose");
  }, [enabled, result]);
  useEffect(() => {
    const previous = stops.current.get(debug.target);
    const changed = previous === undefined ? paused.current?.[debug.target]?.paused === false : previous !== debug.stopSeq;
    stops.current.set(debug.target, debug.stopSeq); paused.current = debug.targets;
    if (enabled && changed && debug.paused) autoWorkbenchLayout("debug");
  }, [enabled, debug.target, debug.stopSeq, debug.paused, debug.targets]);
}
