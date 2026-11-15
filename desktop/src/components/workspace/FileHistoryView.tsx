import { useWorkspaceSelector } from "../../lib/workspaceSession";
import { useHistoryRestorePath } from "../../lib/historyRestoreGuard";
import { isUnsaved } from "../../lib/tabDirty";
import { HistoryPanel } from "./HistoryPanel";

export function FileHistoryView({ activePath, onRestored }: { activePath: string | null; onRestored: (path: string) => Promise<void> | void }) {
  const restoringPath = useHistoryRestorePath();
  const path = restoringPath ?? activePath;
  const tab = useWorkspaceSelector(s => s.tabs.find(t => t.path === path));
  if (!path || path.includes("://")) return <div className="ncf-empty">打开一个工程文件，查看自动归档的本地版本。</div>;
  return <HistoryPanel embedded open path={path} mtimeMs={tab?.mtimeMs} dirty={tab ? isUnsaved(tab) : false} onClose={() => {}} onRestored={onRestored} />;
}
