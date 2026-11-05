import { useEffect, useRef } from "react";
import { clearWorkspacePicker, useWorkspacePick } from "../lib/workspacePicker";
import { pickFolder, pickFolderError } from "../lib/folderPicker";
import { toast } from "../components/ui/toast";

/**
 * 标题栏「打开其他工作区…」与文件树入口共用同一个切换实现，
 * 避免任何入口绕过未保存文件的守卫。
 *
 * 没有路径时拉起系统文件夹选择器（不再回落到手填输入框）；取消就什么都不做。
 */
export function useWorkspacePicker({ root, applyRoot }: {
  root: string | null;
  applyRoot: (path: string) => Promise<string | null>;
}) {
  const pick = useWorkspacePick();
  const consumed = useRef(0);
  const picking = useRef(false);
  useEffect(() => {
    if (!pick || consumed.current === pick.nonce) return;
    consumed.current = pick.nonce;
    clearWorkspacePicker(pick.nonce);
    if (pick.path) {
      void applyRoot(pick.path);
      return;
    }
    // 选择器是异步的：连点两次菜单不应叠两个对话框。
    if (picking.current) return;
    picking.current = true;
    void pickFolder({ title: "选择工程目录", defaultPath: root ?? undefined })
      .then((path) => (path ? applyRoot(path) : null))
      .catch((e) => toast(pickFolderError(e), "error"))
      .finally(() => {
        picking.current = false;
      });
  }, [pick, root, applyRoot]);
}
