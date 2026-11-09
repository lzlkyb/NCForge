import { useEffect, useRef } from "react";
import { onExternalJavaChanged } from "../lib/externalJavaChanges";
import { isModelDirty } from "../lib/editorStore";
import { getSession } from "../lib/workspaceSession";
import { filePathKey } from "../lib/workspace";

/**
 * 外部程序（git / SVN 更新、别的编辑器、脚本）改了磁盘上的 `.java` 时，
 * 把已打开且**没有未保存修改**的标签刷新成磁盘版本。
 *
 * 不刷新的后果：编辑器显示旧内容，用户在旧内容上改一个字再保存，要么撞上冲突提示，
 * 要么（没撞上时）把外部改动悄悄覆盖掉。有未保存修改的标签不动，仍由保存时的冲突
 * 检测（`CONFLICT`）兜底：替用户丢弃他正在写的内容比显示旧内容更糟。
 */
export function useExternalReload(reloadFile: (path: string) => Promise<void>) {
  const reloadRef = useRef(reloadFile);
  reloadRef.current = reloadFile;
  useEffect(
    () =>
      onExternalJavaChanged((paths) => {
        const tabs = getSession().tabs;
        for (const p of paths) {
          const tab = tabs.find((t) => filePathKey(t.path) === filePathKey(p));
          if (!tab || isModelDirty(tab.path)) continue;
          void reloadRef.current(tab.path);
        }
      }),
    [],
  );
}
