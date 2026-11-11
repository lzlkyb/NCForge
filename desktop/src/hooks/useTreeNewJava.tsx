import { useState, type ReactNode } from "react";
import { NewJavaTypeDialog } from "../components/workspace/NewJavaTypeDialog";

/**
 * 文件树的「新建 Java 类型…」：持有目标目录，渲染对话框，创建成功后刷新目录并通知调用方打开文件。
 * 从 `FileTree` 抽出来是因为组件体量门禁。
 */
export function useTreeNewJava({
  root,
  load,
  expand,
  setSelected,
  onCreated,
  onEntryCreated,
}: {
  root: string;
  load: (path: string) => Promise<void>;
  expand: (path: string) => void;
  setSelected: (v: { path: string; isDir: boolean }) => void;
  onCreated: (path: string) => void;
  onEntryCreated?: (path: string) => void;
}): { openNewJava: (target: { path: string; isDir: boolean }) => void; newJavaDialog: ReactNode } {
  const [parent, setParent] = useState<string | null>(null);
  const newJavaDialog = parent ? (
    <NewJavaTypeDialog
      root={root}
      parent={parent}
      onClose={() => setParent(null)}
      onCreated={(created) => {
        const dir = parent;
        setParent(null);
        onEntryCreated?.(created);
        expand(dir);
        void load(dir).then(() => {
          setSelected({ path: created, isDir: false });
          onCreated(created);
        });
      }}
    />
  ) : null;
  const openNewJava = (t: { path: string; isDir: boolean }) => {
    if (t.isDir) setParent(t.path);
  };
  return { openNewJava, newJavaDialog };
}
