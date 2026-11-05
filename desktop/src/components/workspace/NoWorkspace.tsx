import { useRef, useState } from "react";
import { useOperations } from "../../lib/operations";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/EmptyState";
import { Icon } from "../ui/icon";
import { pickFolder, pickFolderError } from "../../lib/folderPicker";
import { baseName } from "../../lib/workspace";

/**
 * 还没选工作区时的引导页：只通过系统文件夹选择器挑目录，不让用户手打路径。
 *
 * 手填路径的失败面太大（斜杠方向、大小写、目录不存在），而选择器至少要
 * 让用户看见真实存在的文件夹；失败原因仍然留在按钮下方，不靠几秒后消失的 toast。
 */
export function NoWorkspace({
  recents,
  onOpen,
}: {
  /** 最近打开过的工作区：新装机器没有，列表为空时不占空间。 */
  recents: string[];
  /** 打开失败时返回原因（页面同时也会 toast），成功返回 null。 */
  onOpen: (path: string) => Promise<string | null>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const tasks = useOperations();
  const switching = busy || tasks.some((o) => o.key === "workspace.switch" && o.endedAt === undefined);

  const run = async (path: string) => {
    if (!path.trim() || lock.current || switching) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      setError(await onOpen(path));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  const choose = async () => {
    if (lock.current || switching) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const path = await pickFolder({ title: "选择 NC 二开工程根目录" });
      // 取消选择不是错误：保持当前页面，等用户再决定。
      if (!path) return;
      setError(await onOpen(path));
    } catch (e) {
      setError(pickFolderError(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4">
      <EmptyState
        icon="folder"
        description="还没有打开工程目录。用系统文件夹选择器挑 NC 二开工程的根目录（如 newar 所在的路径）。"
        className="w-full max-w-[420px] px-4 py-10"
        action={
          <div className="flex w-full max-w-[360px] flex-col gap-1.5">
            <Button
              disabled={switching}
              isLoading={switching}
              loadingText="切换中"
              onClick={() => void choose()}
            >
              <Icon name="folder" size={13} />
              选择工程目录…
            </Button>
            {error && (
              <div id="wb-root-error" role="alert" className="wb-root-error">
                {error}
              </div>
            )}
          </div>
        }
      />
      {recents.length > 0 && (
        <div className="wb-root-recent wb-root-recent-empty">
          <span className="wb-root-recent-label">最近打开</span>
          {recents.map((p) => (
            <button key={p} type="button" className="wb-root-recent-item" title={p}
              disabled={switching} onClick={() => void run(p)}>
              <span className="wb-root-recent-name">{baseName(p)}</span>
              <span className="wb-root-recent-path">{p}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
