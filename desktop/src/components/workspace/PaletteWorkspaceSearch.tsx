import { SearchTab } from "../tabs/SearchTab";
import { useTreeProjects } from "../../hooks/useTreeProjects";
import { useWorkspaceSelector } from "../../lib/workspaceSession";
import { requestSearchOpen } from "../../lib/searchOpenRequest";

export function PaletteWorkspaceSearch({ onExecute }: { onExecute: () => void }) {
  const root = useWorkspaceSelector(session => session.root);
  const { projects } = useTreeProjects(root ?? null);
  return <SearchTab embedded projects={projects}
    onOpenLibraryFile={hit => { onExecute(); requestSearchOpen({ kind: "library", hit }); }}
    onOpenFile={(path, line, column) => { onExecute(); requestSearchOpen({ kind: "file", path, line, column }); }}
    onOpenJarClass={(jar, className) => { onExecute(); requestSearchOpen({ kind: "jar", jar, className, line: 1, source: false }); }}
    onOpenSrcNote={(jar, className, line) => { onExecute(); requestSearchOpen({ kind: "jar", jar, className, line, source: true }); }} />;
}
