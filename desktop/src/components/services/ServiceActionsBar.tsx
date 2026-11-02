import { Icon } from "../ui/icon";
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
}: {
  configOpen: boolean;
  onToggleConfig: () => void;
  previewing: boolean;
  onCommandLine: () => void;
  onRevealLog: () => void;
}) {
  return (
    <div className="sv-svc-bar">
      <span className="sv-svc-name">
        <Icon name="server" size={13} />
        NC 中间件
      </span>
      <span className="sv-sp" />
      <button
        type="button"
        className="sv-btn"
        data-on={configOpen || undefined}
        onClick={onToggleConfig}
      >
        配置
      </button>
      <button
        type="button"
        className="sv-btn"
        disabled={previewing}
        title={previewing ? "正在生成上次启动的命令行…" : "查看启动命令行（只读预览，不会重写 classpath）"}
        onClick={onCommandLine}
      >
        <Icon name="terminal" size={13} />
        {previewing ? "生成中…" : "命令行"}
      </button>
      <button type="button" className="sv-btn" onClick={onRevealLog}>
        <Icon name="folder" size={13} />
        日志位置
      </button>
      <NccDecodeLauncher />
    </div>
  );
}
