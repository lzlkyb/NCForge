import { Icon } from "../ui/icon";
import { UNKNOWN_PROCESS_NAME, type ServerStatus } from "../../lib/server";

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
}: {
  status: ServerStatus | null;
  busy: boolean;
  onKill: () => void;
  onNavigate: (tab: string) => void;
}) {
  const owner = status?.portOwner ?? null;
  const conflict = !!owner && !status?.portOwnedBySelf;
  const ownerIsJava = !!owner && owner.name.toLowerCase().startsWith("java");
  // 读不到进程名时后端给的是占位值（Rust `server::UNKNOWN_PROCESS`，前端同名常量）。
  // 那不等于「不是 java」：早先这里一律落到「它不是 java 进程」，等于替用户
  // 下了一个我们并不知道的结论——而用户会据此去任务管理器里找一个「非 java」的进程。
  const ownerUnknown = !!owner && owner.name === UNKNOWN_PROCESS_NAME;

  return (
    <>
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
