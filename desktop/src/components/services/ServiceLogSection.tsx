import { useState } from "react";
import { LogPanel } from "./LogPanel";
import type { ServiceLogSource } from "../../lib/logPanelStore";

export interface ServiceLogPane {
  active: boolean;
  generation: number;
  logPath: string;
  logSize: number;
  onReveal: (previous?: boolean) => void;
  onCleared: () => void;
  runId?: string | null;
  projectRoot?: string | null;
  visible?: boolean;
}

/**
 * 日志区：中间件 / 客户端两个日志文件共用一个面板，用顶部的来源切换。
 *
 * 不做成两个并排面板：底部停靠区高度有限，两边都看时各剩一半行数；
 * 而排查时几乎总是只看一边。两个面板保持挂载，切换来源保留各自过滤和滚动位置；
 * 隐藏面板停止读取，日志数据由来源与运行身份隔离，避免行和 offset 串用。
 */
export function ServiceLogSection({
  appHidden,
  middleware,
  client,
  source: selected,
  onSourceChange,
}: {
  appHidden: boolean;
  middleware: ServiceLogPane;
  client: ServiceLogPane;
  source?: ServiceLogSource;
  onSourceChange?: (source: ServiceLogSource) => void;
}) {
  const [localSource, setSource] = useState<ServiceLogSource>("middleware");
  const source = selected ?? localSource;

  return (
    <div className="sc-log-section">
      {selected === undefined && <div className="sv-log-src" role="tablist" aria-label="日志来源">
        {(
          [
            ["middleware", "中间件日志", "middleware.log"],
            ["client", "客户端日志", "client.log"],
          ] as const
        ).map(([id, text, file]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={source === id}
            data-on={source === id || undefined}
            onClick={() => { setSource(id); onSourceChange?.(id); }}
          >
            {text}
            <span className="sv-log-src-file">{file}</span>
          </button>
        ))}
      </div>}
      {([['middleware', middleware], ['client', client]] as const).map(([target, pane]) => <div className="sc-log-pane" key={target} hidden={source !== target}>
        <LogPanel active={pane.active} generation={pane.generation} logPath={pane.logPath} logSize={pane.logSize} appHidden={appHidden} visible={source === target && pane.visible !== false}
          onReveal={pane.onReveal} onCleared={pane.onCleared} target={target} runId={pane.runId} projectRoot={pane.projectRoot} />
      </div>)}
    </div>
  );
}
