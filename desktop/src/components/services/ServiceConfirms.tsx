import { ConfirmDialog } from "../ui/ConfirmDialog";

/**
 * 服务页的三个破坏性确认框（停服务 / 重启 / 结束占用进程）。
 *
 * 从 ServicesTab 抽出来只为一件小事：那个文件已经顶到「单文件 300 行」的体量门禁，
 * 而这三个弹窗是整块纯展示 UI——搬走不掉任何行为，ServicesTab 回到门禁内。
 *（门禁的拆分思路原文：独立 UI 区块 → 子组件。）
 */
export function ServiceConfirms({
  confirm,
  port,
  ownerName,
  ownerPid,
  onCancel,
  onConfirmStop,
  onConfirmRestart,
  onConfirmKill,
}: {
  confirm: "stop" | "restart" | "kill" | null;
  /** 当前端口，仅用于弹窗标题。 */
  port: number;
  ownerName: string | undefined;
  ownerPid: number | undefined;
  onCancel: () => void;
  onConfirmStop: () => void;
  onConfirmRestart: () => void;
  onConfirmKill: () => void;
}) {
  // 读不到进程名时后端给的是「未知进程」：这颗按钮点了多半会被后端挡回来，
  // 与其让它看起来像个确定可用的操作，不如把「我也不知道它是什么」说在前面。
  const nameUnknown = ownerName === "未知进程";

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

      {/* 重启 = 一停一起，代价和「停止」完全一样，所以仍然要问一句：
          开发时手滑点错的成本是所有人断线十秒，不是本机多等一会儿 */}
      <ConfirmDialog
        open={confirm === "restart"}
        title="重启 NC 中间件？"
        description="会先停止再启动：连着的客户端断开约 10 秒（重新加载 200 多个模块）。刚改的代码会在这之后生效。"
        variant="destructive"
        confirmLabel="重启"
        onCancel={onCancel}
        onConfirm={onConfirmRestart}
      />

      <ConfirmDialog
        open={confirm === "kill"}
        title={`结束占用 ${port} 端口的进程？`}
        description={
          nameUnknown ? (
            <>
              抓到了占着 {port} 端口的 PID <b>{ownerPid}</b>，但读不到它的进程名。
              本工具会再实时查一次名字，确认是 java 才结束——查不到就什么都不做。
              如果它正在被别的客户端使用，那些客户端会立刻断线。
            </>
          ) : (
            <>
              将强制结束 <b>{ownerName}</b>（PID {ownerPid}）及其子进程。
              如果它正在被别的客户端使用，那些客户端会立刻断线。
            </>
          )
        }
        variant="destructive"
        confirmLabel={nameUnknown ? "再查一次并结束" : "结束进程"}
        onCancel={onCancel}
        onConfirm={onConfirmKill}
      />
    </>
  );
}
