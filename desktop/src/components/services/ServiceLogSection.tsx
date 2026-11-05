import { useState } from "react";
import { LogPanel } from "./LogPanel";
import { clientClearLog, clientLog } from "../../lib/client";

export interface ServiceLogPane {
  active: boolean;
  generation: number;
  logPath: string;
  logSize: number;
  onReveal: () => void;
  onCleared: () => void;
}

/**
 * 日志区：中间件 / 客户端两个日志文件共用一个面板，用顶部的来源切换。
 *
 * 不做成两个并排面板：底部停靠区高度有限，两边都看时各剩一半行数；
 * 而排查时几乎总是只看一边。切换时用 `key={source}` 重建 `LogPanel`，
 * 免得把另一份日志的行和 offset 带到这一边。
 */
export function ServiceLogSection({
  appHidden,
  middleware,
  client,
}: {
  appHidden: boolean;
  middleware: ServiceLogPane;
  client: ServiceLogPane;
}) {
  const [source, setSource] = useState<"middleware" | "client">("middleware");
  const pane = source === "client" ? client : middleware;

  return (
    <div className="sv-log-wrap">
      <div className="sv-log-src" role="tablist" aria-label="日志来源">
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
            onClick={() => setSource(id)}
          >
            {text}
            <span className="sv-log-src-file">{file}</span>
          </button>
        ))}
      </div>
      <LogPanel
        key={source}
        active={pane.active}
        generation={pane.generation}
        logPath={pane.logPath}
        logSize={pane.logSize}
        appHidden={appHidden}
        onReveal={pane.onReveal}
        onCleared={pane.onCleared}
        target={source}
        fetchLog={source === "client" ? clientLog : undefined}
        clearLog={source === "client" ? clientClearLog : undefined}
      />
    </div>
  );
}
