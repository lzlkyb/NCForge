import { useQuery } from "@tanstack/react-query";
import { useAppHidden } from "../../lib/appVisibility";
import { serverStatus, type ServerState } from "../../lib/server";
import { openServicePanel } from "../../lib/servicePanel";

const LABELS: Record<ServerState, string> = {
  stopped: "已停止",
  starting: "启动中",
  running: "运行中",
};

/**
 * 状态栏里的 NC 服务入口。
 *
 * NC 服务不再是主导航页签，但它是日常动线的第一步（起服务 → 改代码 → 看日志），
 * 所以在文件页状态栏常驻一个状态胶囊：一眼看到启停状态，点一下直达底部服务面板。
 * 轮询放慢到 5 秒——服务面板自己开着时会用 1 秒轮询，这里只需要跟得上状态变化。
 */
export function ServiceStatusButton() {
  const appHidden = useAppHidden();
  const { data } = useQuery({
    queryKey: ["server-status"],
    queryFn: serverStatus,
    refetchInterval: appHidden ? false : 5000,
    retry: false,
  });
  const state = data?.state;
  const label = state ? LABELS[state] : "状态未知";
  // 端口跟着状态一起报：服务起来了但连不上时，第一个要核对的就是「连的是哪个端口」
  const port = state === "running" && data?.port ? data.port : null;
  const where = port ? ` · ${data?.portAddress ? `${data.portAddress}:` : ":"}${port}` : "";
  return (
    <button
      type="button"
      className="wb-status-svc"
      data-state={state ?? "unknown"}
      title={`NC 中间件${label}${where} · 点击打开服务面板`}
      onClick={openServicePanel}
    >
      <span className="wb-status-svc-dot" />
      NC 服务 · {label}
      {port !== null && <span className="wb-status-svc-port">:{port}</span>}
    </button>
  );
}
