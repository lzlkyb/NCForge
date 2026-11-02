import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { ConnPicker } from "./ConnPicker";
import { friendlyDbError } from "../../lib/db";
import { switchConn } from "../../lib/dbActions";
import { connOf, ensureSlot, patchTab, rtOf, txAction, useDb, type SqlTab } from "../../lib/dbStore";

/** SQL 控制台工具条：连接胶囊 · 执行 / 脚本 / 计划 / 格式化 · 事务模式 · 历史。生产库整条淡红。 */
export function SqlToolbar({ tab, onRun, onStop, onExplain, onFormat, onExport, onValueSearch, onScriptReplay, historyOpen, onHistory, snipsOpen, onSnips, sessionsOpen, onSessions }: {
  tab: SqlTab;
  onRun: (mode: "current" | "script") => void;
  onStop: () => void;
  onExplain: () => void;
  onFormat: () => void;
  /** 把光标处语句的结果导成 insert 脚本。 */
  onExport: () => void;
  /** 全库按值反查（只读）。 */
  onValueSearch: () => void;
  /** 选一个 .sql 文件逐条回放（现场迁移脚本）。 */
  onScriptReplay: () => void;
  historyOpen: boolean;
  onHistory: () => void;
  /** 片段抽屉是否打开（按钮高亮用）。 */
  snipsOpen: boolean;
  onSnips: () => void;
  /** 会话与锁抽屉是否打开（按钮高亮用）。 */
  sessionsOpen: boolean;
  onSessions: () => void;
}) {
  useDb();
  const conn = connOf(tab.connId);
  const rt = rtOf(tab.connId);
  const connected = rt.status === "connected";
  // 有槽看槽、没槽看 primary：SQL 标签执行一次之后所有语句都跑在独立槽里，
  // 只读 primary 会把「另一条会话」的模式显示成这个标签的模式。
  const tx = tab.slot ? tab.tx : rt.tx;
  const auto = tx?.autoCommit ?? conn?.autoCommit ?? false;
  const pending = (tx?.statements ?? 0) > 0;

  const setMode = async (on: boolean) => {
    if (!tab.connId || !connected || on === auto) return;
    try {
      // 先拿到这条标签自己的会话：槽按连接保存的默认值创建，不会继承刚才对 primary
      // 的临时切换。不先 ensureSlot 就直接切 primary，等于切了一条这个标签不用的会话。
      const slot = await ensureSlot(tab.id, tab.connId);
      const next = await txAction(tab.connId, on ? "autocommit-on" : "autocommit-off", slot);
      if (slot) patchTab<SqlTab>(tab.id, { tx: next });
      // 切到自动提交时 JDBC 会把未提交的事务一并提交：给一句提示
      if (on && pending) toast("已切到自动提交，之前未提交的语句已一并提交", "warning");
    } catch (e) {
      toast(`切换失败：${friendlyDbError(e)}`, "error");
    }
  };

  return (
    <div className="dbx-sqlbar" data-prod={conn?.env === "prod" || undefined}>
      <ConnPicker connId={tab.connId} onPick={(id) => void switchConn(tab.id, id)} />
      {tab.running ? (
        // 执行中把「执行」换成「停止」：以前只能干等 30 秒超时，或者杀掉整个应用。
        // 能不能停按 `Caps.cancel` 决定（两个引擎现在都支持，但要留出按能力降级的路）：
        // 让它可点再报错，用户会以为语句已经在库里停了。
        <button
          type="button"
          className="dbx-btn bad"
          disabled={rt.caps ? !rt.caps.cancel : false}
          onClick={onStop}
          title={
            rt.caps && !rt.caps.cancel
              ? "这个连接用不了语句中断，只能等它自己跑完或超时"
              : "取消正在执行的语句（数据库侧会收到 ORA-01013）"
          }
        >
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
      <button
        type="button"
        className="dbx-btn ghost"
        disabled={tab.running || !conn}
        onClick={onScriptReplay}
        title="选一个 .sql 文件，按语句逐条回放（UTF-8 / GBK 自动识别，可忽略错误继续）"
      >
        <Icon name="upload" size={12} />
        回放 .sql
      </button>
      <button type="button" className="dbx-btn ghost" disabled={tab.running || !conn} onClick={onExplain} title="EXPLAIN PLAN，不真正执行">
        <Icon name="activity" size={12} />
        执行计划
      </button>
      <button type="button" className="dbx-btn ghost" onClick={onFormat} title="Ctrl+Shift+F">
        <Icon name="paintbrush" size={12} />
        格式化
      </button>
      <button
        type="button"
        className="dbx-btn ghost"
        disabled={tab.running || !conn}
        onClick={onExport}
        title="把光标处这条查询的结果导成 insert 脚本（后端取全量）"
      >
        <Icon name="download" size={12} />
        导出 INSERT
      </button>
      <button
        type="button"
        className="dbx-btn ghost"
        disabled={tab.running || !conn}
        onClick={onValueSearch}
        title="拿一段文本在全库所有表的文本列里找（只读，可看进度和取消）"
      >
        <Icon name="search" size={12} />
        按值反查
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
      <button
        type="button"
        className="dbx-btn ghost"
        data-on={snipsOpen || undefined}
        onClick={onSnips}
        disabled={!tab.connId}
        title="常用 SQL 存下来，点一下填回编辑器（本机保存，不上传）"
      >
        <Icon name="code" size={12} />
        片段
      </button>
      <button
        type="button"
        className="dbx-btn ghost"
        data-on={sessionsOpen || undefined}
        onClick={onSessions}
        disabled={!tab.connId}
        title="谁在跑、谁锁了哪张表（只读，不代执行 KILL）"
      >
        <Icon name="lock" size={12} />
        会话
      </button>
    </div>
  );
}
