import { useEffect, useState } from "react";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Icon } from "../ui/icon";
import { baseName } from "../../lib/workspace";
import type { LinkedProject } from "../../lib/linkedProjects";
import { getDirectSwitch, setDirectSwitch } from "../../lib/projectSwitchPref";

/**
 * 跨工程打开文件的确认框。
 *
 * 切换的代价是真实的（关掉全部标签、停掉并重建 jdt.ls 索引），不先说清就会出现
 * 「我只是点了下文件，打开的窗口全没了」。默认每次都问；勾一次「直接切换」以后
 * 不再出现——这个偏好同时暴露在文件树标题栏的开关上。
 */
export function SwitchProjectDialog({
  open,
  from,
  to,
  unsavedCount,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  /** 当前工作区根。 */
  from: string;
  /** 目标工程；null = 还没解析出来。 */
  to: LinkedProject | null;
  /** 当前标签里未保存的个数。 */
  unsavedCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [direct, setDirect] = useState(getDirectSwitch);
  // 每次重新打开都按当前偏好重置勾选（上次取消不该把偏好改掉）
  useEffect(() => {
    if (open) setDirect(getDirectSwitch());
  }, [open]);

  if (!to) return null;

  return (
    <ConfirmDialog
      open={open}
      title={`切换到 ${to.name}？`}
      description={
        <>
          这个文件不在当前工程 <b>{baseName(from) || from}</b> 里。要打开它，得先把工作区切到{" "}
          <b>{to.name}</b>。
        </>
      }
      confirmLabel="切换并打开"
      onCancel={onCancel}
      onConfirm={() => {
        // 只认「确认过的偏好」：取消时不该留下副作用
        setDirectSwitch(direct);
        onConfirm();
      }}
    >
      <ul className="mb-3 space-y-1.5 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] leading-relaxed">
        <li className="flex items-start gap-1.5">
          <Icon name="alertTriangle" size={13} className="mt-0.5 flex-shrink-0 text-warning-ink" />
          <span>
            会关闭当前全部标签
            {unsavedCount > 0 ? (
              <>
                ，其中 <b className="text-warning-ink">{unsavedCount} 个有未保存的修改</b>
                （切换前会先询问保存）
              </>
            ) : (
              "（没有未保存的修改）"
            )}
            。
          </span>
        </li>
        <li className="flex items-start gap-1.5">
          <Icon name="clock" size={13} className="mt-0.5 flex-shrink-0 text-muted-foreground" />
          <span>Java 索引会按新工程重建，通常需要 3–8 秒，期间补全与跳转不可用。</span>
        </li>
        <li className="flex items-start gap-1.5">
          <Icon name="info" size={13} className="mt-0.5 flex-shrink-0 text-muted-foreground" />
          <span>
            之后的编译、SVN 与「当前工程」搜索只作用于 <b>{to.name}</b>；依赖范围由它的{" "}
            <code>.classpath</code> 决定。
          </span>
        </li>
      </ul>

      <label className="flex cursor-pointer items-center gap-2 text-[12px] text-muted-foreground">
        <input
          type="checkbox"
          checked={direct}
          onChange={(e) => setDirect(e.target.checked)}
          className="h-3.5 w-3.5 accent-primary"
        />
        以后跨工程打开直接切换（可在文件树标题栏改回）
      </label>
    </ConfirmDialog>
  );
}
