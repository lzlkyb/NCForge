import { Icon } from "../ui/icon";
import { FreshnessBadge } from "../ui/FreshnessBadge";
import { Menu, MenuItem } from "../ui/Menu";
import { NccDecodeLauncher } from "./NccDecodeLauncher";

/**
 * NC 服务面板标题行：配置 / 启动命令行 / 日志位置 / 报文解密。
 *
 * 以前这四个按钮停靠在顶部工具条里，只有切到「NC 服务」页签才出现。服务并进
 * 文件页后没有独立页签，它们跟着服务卡片一起住在底部面板，打开面板就能用。
 */
export function ServiceActionsBar({
  configOpen,
  onToggleConfig,
  previewing,
  onCommandLine,
  onRevealLog,
  known,
  failed,
  onRetryStatus,
}: {
  configOpen: boolean;
  onToggleConfig: () => void;
  previewing: boolean;
  onCommandLine: () => void;
  onRevealLog: () => void;
  /** 拿到过状态（徽标显示「实时」）；面板不可见时轮询会暂停，但徽标本身不可见。 */
  known: boolean;
  failed: boolean;
  onRetryStatus: () => void;
}) {
  return (
    <div className="sv-svc-bar">
      <span className="sv-svc-name">
        <Icon name="server" size={13} />
        NC 中间件
      </span>
      <FreshnessBadge
        // 1 秒轮询是实时流，不显示秒级时间戳；失败时由徽标给出重试。
        state={failed ? "error" : known ? "live" : "loading"}
        at={null}
        label="服务状态"
        onRefresh={onRetryStatus}
      />
      <span className="sv-sp" />
      <button
        type="button"
        className="sv-btn"
        data-on={configOpen || undefined}
        aria-expanded={configOpen}
        onClick={onToggleConfig}
      >
        配置
      </button>
      <button type="button" className="sv-btn" onClick={onRevealLog}>
        <Icon name="folder" size={13} />
        日志位置
      </button>
      {/* 入口一直挂载，命令面板中的报文解密不会随菜单关闭而消失。 */}
      <NccDecodeLauncher trigger={(onDecode) => (
        <Menu portal trigger={(open, toggle) => (
          <button
            type="button"
            className="sv-icon-btn"
            data-on={open || undefined}
            aria-label="更多服务工具"
            aria-haspopup="menu"
            aria-expanded={open}
            title="更多服务工具"
            onClick={toggle}
          >
            <Icon name="more" size={14} />
          </button>
        )}>
          {(close) => (
            <>
              <MenuItem
                label={previewing ? "命令行生成中…" : "启动命令行"}
                icon="terminal"
                hint="只读预览"
                disabled={previewing}
                onClick={() => { close(); onCommandLine(); }}
              />
              <MenuItem
                label="NCC / BIP 报文解密"
                icon="key"
                onClick={() => { close(); onDecode(); }}
              />
            </>
          )}
        </Menu>
      )} />
    </div>
  );
}
