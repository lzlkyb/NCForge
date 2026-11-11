import { servicePollInterval } from "../../lib/servicePolling";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAppHidden } from "../../lib/appVisibility";
import { serverStatus } from "../../lib/server";
import { openServicePanel } from "../../lib/servicePanel";
import { servicePresentation } from "../../lib/servicePresentation";

/**
 * 状态栏里的 NC 服务入口。
 *
 * NC 服务不再是主导航页签，但它是日常动线的第一步（起服务 → 改代码 → 看日志），
 * 所以在文件页状态栏常驻一个状态胶囊：一眼看到启停状态，点一下直达底部服务面板。
 * 轮询放慢到 5 秒——服务面板自己开着时会用 1 秒轮询，这里只需要跟得上状态变化。
 */
export function ServiceStatusButton({ header = false }: { header?: boolean }) {
  const appHidden = useAppHidden();
  const pollInterval = useMemo(servicePollInterval, []);
  const { data, isError } = useQuery({
    queryKey: ["server-status"],
    queryFn: serverStatus,
    refetchInterval: appHidden ? false : pollInterval,
    retry: false,
  });
  const { state, label } = servicePresentation("middleware", data ?? null, isError);
  // 端口跟着状态一起报：服务起来了但连不上时，第一个要核对的就是「连的是哪个端口」
  const port = state === "running" && data?.port ? data.port : null;
  const where = port ? ` · ${data?.portAddress ? `${data.portAddress}:` : ":"}${port}` : "";
  return (
    <button
      type="button"
      className={header ? "wb-service-entry ux-btn" : "wb-status-svc"}
      data-state={state ?? "unknown"}
      title={`NC 中间件${label}${where} · 点击打开服务面板`}
      onClick={openServicePanel}
    >
      <span className="wb-status-svc-dot" />
      {header ? <><span>NC 服务</span><small>{label}</small></> : <>NC 服务 · {label}</>}
      {!header && port !== null && <span className="wb-status-svc-port">:{port}</span>}
    </button>
  );
}
