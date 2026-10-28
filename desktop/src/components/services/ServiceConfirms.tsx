import { ConfirmDialog } from "../ui/ConfirmDialog";

/**
 * 服务页的两个破坏性确认框（停服务 / 结束占用进程）。
 *
 * 从 ServicesTab 抽出来只为一件小事：那个文件已经顶到「单文件 300 行」的体量门禁，
 * 而这两个弹窗是整块纯展示 UI——搬走不掉任何行为，ServicesTab 回到门禁内。
 *（门禁的拆分思路原文：独立 UI 区块 → 子组件。）
 */
export function ServiceConfirms({
  confirm,
  port,
  ownerName,
  ownerPid,
  onCancel,
  onConfirmStop,
  onConfirmKill,
}: {
  confirm: "stop" | "kill" | null;
  /** 当前端口，仅用于弹窗标题。 */
  port: number;
  ownerName: string | undefined;
  ownerPid: number | undefined;
  onCancel: () => void;
  onConfirmStop: () => void;
  onConfirmKill: () => void;
}) {
  return (
    <>
      <ConfirmDialog
        open={confirm === "stop"}
        title="停止 NC 中间件？"
        description="正在使用这个服务的客户端会立刻断开。停机后要重新加载 200 多个模块，大约 10 秒才能再连上。"
        variant="destructive"
        confirmLabel="停止"
        onCancel={onCancel}
        onConfirm={onConfirmStop}
      />

      <ConfirmDialog
        open={confirm === "kill"}
        title={`结束占用 ${port} 端口的进程？`}
        description={
          <>
            将强制结束 <b>{ownerName}</b>（PID {ownerPid}）及其子进程。
            如果它正在被别的客户端使用，那些客户端会立刻断线。
          </>
        }
        variant="destructive"
        confirmLabel="结束进程"
        onCancel={onCancel}
        onConfirm={onConfirmKill}
      />
    </>
  );
}
