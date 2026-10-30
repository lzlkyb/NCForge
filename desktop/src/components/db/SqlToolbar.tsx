import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { ConnPicker } from "./ConnPicker";
import { friendlyDbError } from "../../lib/db";
import { switchConn } from "../../lib/dbActions";
import { connOf, rtOf, txAction, useDb, type SqlTab } from "../../lib/dbStore";

/** SQL 控制台工具条：连接胶囊 · 执行 / 脚本 / 计划 / 格式化 · 事务模式 · 历史。生产库整条淡红。 */
export function SqlToolbar({ tab, onRun, onStop, onExplain, onFormat, historyOpen, onHistory }: {
  tab: SqlTab;
  onRun: (mode: "current" | "script") => void;
  onStop: () => void;
  onExplain: () => void;
  onFormat: () => void;
  historyOpen: boolean;
  onHistory: () => void;
}) {
  useDb();
  const conn = connOf(tab.connId);
  const rt = rtOf(tab.connId);
  const connected = rt.status === "connected";
  const auto = rt.tx?.autoCommit ?? conn?.autoCommit ?? false;
  const pending = (rt.tx?.statements ?? 0) > 0;

  const setMode = async (on: boolean) => {
    if (!tab.connId || !connected || on === auto) return;
    try {
      // 切到自动提交时 JDBC 会把未提交的事务一并提交：给一句提示
      await txAction(tab.connId, on ? "autocommit-on" : "autocommit-off");
      if (on && pending) toast("已切到自动提交，之前未提交的语句已一并提交", "warning");
    } catch (e) {
      toast(`切换失败：${friendlyDbError(e)}`, "error");
    }
  };

  return (
    <div className="dbx-sqlbar" data-prod={conn?.env === "prod" || undefined}>
      <ConnPicker connId={tab.connId} onPick={(id) => void switchConn(tab.id, id)} />
      {tab.running ? (
        // 执行中把「执行」换成「停止」：以前只能干等 30 秒超时，或者杀掉整个应用
        <button type="button" className="dbx-btn bad" onClick={onStop} title="取消正在执行的语句（数据库侧会收到 ORA-01013）">
          <Icon name="stop" size={12} />
          停止
        </button>
      ) : (
        <button type="button" className="dbx-btn pri" disabled={!conn} onClick={() => onRun("current")} title="执行光标所在的语句（有选中则执行选中部分）">
          <Icon name="play" size={12} />
          执行 <span className="k">Ctrl+Enter</span>
        </button>
      )}
      <button type="button" className="dbx-btn" disabled={tab.running || !conn} onClick={() => onRun("script")} title="按顺序执行整个脚本，出错即停">
        <Icon name="terminal" size={12} />
        执行脚本 <span className="k">Alt+X</span>
      </button>
      <button type="button" className="dbx-btn ghost" disabled={tab.running || !conn} onClick={onExplain} title="EXPLAIN PLAN，不真正执行">
        <Icon name="activity" size={12} />
        执行计划
      </button>
      <button type="button" className="dbx-btn ghost" onClick={onFormat} title="Ctrl+Shift+F">
        <Icon name="paintbrush" size={12} />
        格式化
      </button>
      <span className="dbx-vsep" />
      <div className="dbx-txmode" title={connected ? "本连接的事务模式（临时切换，默认值在连接设置里）" : "连上后可切换"}>
        <button type="button" disabled={!connected} data-on={!auto || undefined} onClick={() => void setMode(false)}>
          手动提交
        </button>
        <button type="button" disabled={!connected} data-on={auto || undefined} onClick={() => void setMode(true)}>
          自动提交
        </button>
      </div>
      <span className="dbx-sp" />
      <button type="button" className="dbx-btn ghost" data-on={historyOpen || undefined} onClick={onHistory} disabled={!tab.connId}>
        <Icon name="history" size={12} />
        历史
      </button>
    </div>
  );
}
