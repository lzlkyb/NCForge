import { Icon } from "../ui/icon";
import { UNKNOWN_PROCESS_NAME, type ServerStatus } from "../../lib/server";
import { failureSummary, shortClassName, type HotswapStatus } from "../../lib/hotswap";
import { openLinkedDialog } from "../../lib/linkedDialog";

/**
 * 服务页的两条告警：端口被别人的进程占着、还没选工程目录。
 *
 * 端口争用的判断（是不是 java、进程名读不读得到）全在这里做：
 * 调用处只需要知道「要不要结束它」。
 */
export function ServiceAlerts({
  status,
  busy,
  onKill,
  onNavigate,
  hotswap,
  onRestart,
}: {
  status: ServerStatus | null;
  busy: boolean;
  onKill: () => void;
  onNavigate: (tab: string) => void;
  /** 热替换状态：stale 时出告警条，直到下次重启服务。 */
  hotswap?: HotswapStatus | null;
  onRestart?: () => void;
}) {
  const owner = status?.portOwner ?? null;
  const conflict = !!owner && !status?.portOwnedBySelf;
  const ownerIsJava = !!owner && owner.name.toLowerCase().startsWith("java");
  // 读不到进程名时后端给的是占位值（Rust `server::UNKNOWN_PROCESS`，前端同名常量）。
  // 那不等于「不是 java」：早先这里一律落到「它不是 java 进程」，等于替用户
  // 下了一个我们并不知道的结论——而用户会据此去任务管理器里找一个「非 java」的进程。
  const ownerUnknown = !!owner && owner.name === UNKNOWN_PROCESS_NAME;
  // 只在服务运行中讲：停了之后下次启动加载的就是磁盘上的新产物
  const stale = status?.state === "running" && hotswap?.stale ? hotswap.staleReport : null;

  return (
    <>
      {stale && (
        <div className="sv-alert" data-tone={stale.state === "failed" ? undefined : "warn"}>
          <Icon name={stale.state === "failed" ? "alertTriangle" : "info"} size={14} />
          <span className="sv-alert-text">
            {stale.state === "failed" ? (
              <>
                {stale.target === "client" ? "客户端里" : ""}运行中的代码<b>不是最新</b>。{new Date(stale.atMs).toLocaleTimeString()} 那次热替换失败：{failureSummary(stale)}；本批改动没进 JVM{stale.target === "client" ? "，重启客户端后生效" : ""}。
              </>
            ) : (
              <>
                <b>{stale.shadowed.map((s) => shortClassName(s.name)).join("、")}</b> 被 classpath 前面的同名类遮挡，改动不会生效{stale.redefined.length > 0 ? `；其余 ${stale.redefined.length} 个类已替换` : ""}。重启解决不了，要在工程关联里调整顺序或删掉那份同名类。
              </>
            )}
          </span>
          {stale.state !== "failed" && (
            <button type="button" className="sv-btn" onClick={() => openLinkedDialog("chain")}>
              工程关联
            </button>
          )}
          {/* 遮挡不给重启：重启后 classpath 顺序不变，跑的还是那份同名类。
              这个按钮重启的是中间件，客户端的失败不给（文案里已写明重启客户端） */}
          {onRestart && stale.state === "failed" && stale.target !== "client" && (
            <button type="button" className="sv-btn sv-btn-primary" disabled={busy} onClick={onRestart}>
              重启服务
            </button>
          )}
        </div>
      )}
      {conflict && owner && (
        <div className="sv-alert">
          <Icon name="alertTriangle" size={14} />
          <span className="sv-alert-text">
            端口 {status?.port} 被 <b>{owner.name}</b>（PID {owner.pid}）占用
            {ownerIsJava
              ? "，可能是上次没停干净的 NC 中间件。"
              : ownerUnknown
                ? "，但读不到它的进程名——这不等于它不是 java。可以按 PID 在任务管理器里确认。"
                : "，它不是 java 进程，本工具不会替你结束它。"}
          </span>
          {(ownerIsJava || ownerUnknown) && (
            <button
              type="button"
              className="sv-btn sv-btn-danger"
              disabled={busy}
              onClick={onKill}
            >
              结束该进程
            </button>
          )}
        </div>
      )}

      {status && !status.projectRoot && (
        <div className="sv-alert" data-tone="warn">
          <Icon name="info" size={14} />
          <span className="sv-alert-text">
            还没选工程目录：服务能起来，但你改的代码<b>不会生效</b>（用的全是 NC home 里的 jar）。
          </span>
          <button type="button" className="sv-btn" onClick={() => onNavigate("files")}>
            去选工程
          </button>
        </div>
      )}
    </>
  );
}
