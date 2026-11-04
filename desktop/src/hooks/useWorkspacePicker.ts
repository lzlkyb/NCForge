import { useEffect, useRef } from "react";
import { clearWorkspacePicker, useWorkspacePick } from "../lib/workspacePicker";

/** 标题栏与资源树使用同一个切换实现，避免任何入口绕过未保存文件的守卫。 */
export function useWorkspacePicker({ root, setDraft, setEditing, applyRoot }: {
  root: string | null;
  setDraft: (draft: string) => void;
  setEditing: (editing: boolean) => void;
  applyRoot: (path: string) => Promise<string | null>;
}) {
  const pick = useWorkspacePick();
  const consumed = useRef(0);
  useEffect(() => {
    if (!pick || consumed.current === pick.nonce) return;
    consumed.current = pick.nonce;
    clearWorkspacePicker(pick.nonce);
    if (pick.path) void applyRoot(pick.path);
    else {
      setDraft(root ?? "");
      setEditing(true);
    }
  }, [pick, root, setDraft, setEditing, applyRoot]);
}
