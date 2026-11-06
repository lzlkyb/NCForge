import { useQuery } from "@tanstack/react-query";
import { setSession, useWorkspaceRoot, useWorkspaceSelector } from "../../lib/workspaceSession";
import { useCodeDiags } from "../../lib/diagStore";
import { countErrors, mergeProblems } from "../../lib/problemList";
import { svnInfo, svnStatus } from "../../lib/svn";
import { useState } from "react";
import { activateTab, connOf, rtOf, useDbSelector } from "../../lib/dbStore";
import { pendingDbSessions, type PendingDbSession } from "../../lib/dbPendingSessions";
import { showWorkbenchDocument } from "../../lib/dockEvents";
import { openLinkedDialog } from "../../lib/linkedDialog";
import { Icon } from "../ui/icon";
import { Menu, MenuItem } from "../ui/Menu";
import { PrimarySessionSummary } from "../db/PrimarySessionSummary";

/**
 * 状态栏的各页贡献。
 *
 * 状态栏只有一条：它是外壳的，不是「编辑器页的」。这里按当前页补上这一页
 * 最该常驻的信息（编译 / 问题 / 改动 / 连接），而不是每页各画一条。
 *
 * SVN 那两项用 `enabled` 挂住当前页：`svn status` 在这个工作副本上一次要扫
 * 7.6 秒，状态栏不能为了显示一个数字在启动时替用户跑一遍。停在这一页时与页面
 * 共用同一个查询键，不会多扫一次。
 */
export function StatusContributions({ activeTool }: { activeTool: string }) {
  const [primaryConn, setPrimaryConn] = useState<string | null>(null);
  const compiling = useWorkspaceSelector((s) => s.compiling);
  const progress = useWorkspaceSelector((s) => s.buildProgress);
  const compileResult = useWorkspaceSelector((s) => s.compileResult);
  const diags = useCodeDiags();
  const root = useWorkspaceRoot();

  const svnOn = activeTool === "svn";
  const svn = useQuery({
    queryKey: ["svn-status", root ?? ""],
    queryFn: svnStatus,
    enabled: svnOn,
    staleTime: 30_000,
    retry: false,
  });
  const info = useQuery({
    queryKey: ["svn-info", root ?? ""],
    queryFn: svnInfo,
    enabled: svnOn,
    staleTime: 30_000,
    retry: false,
  });

  const db = useDbSelector(
    (s) => {
      if (activeTool !== "db") return null;
      const tab = s.tabs.find((t) => t.id === s.active);
      if (!tab) return null;
      const rt = rtOf(tab.connId);
      return {
        connId: tab.connId,
        name: connOf(tab.connId)?.name ?? "数据库",
        status: rt.status,
        pending: tab.connId ? pendingDbSessions(s, tab.connId) : [],
        running: s.tabs.some((t) => t.kind === "sql" && t.running),
      };
    },
    (a, b) =>
      a === b ||
      (!!a && !!b && a.connId === b.connId && a.name === b.name && a.status === b.status && JSON.stringify(a.pending) === JSON.stringify(b.pending) && a.running === b.running),
  );

  const locateSession = (session: PendingDbSession) => {
    if (!db?.connId) return;
    if (!session.tabId) { setPrimaryConn(db.connId); return; }
    activateTab(session.tabId);
    showWorkbenchDocument();
    window.dispatchEvent(new CustomEvent("ncforge-navigate", { detail: "db" }));
  };

  const problems = mergeProblems(compileResult?.problems, diags);
  const errors = countErrors(problems);
  const warnings = problems.filter((p) => p.severity === "warning").length;
  const ready = svn.data;
  // 模块账本：错误数会加总，但「哪些模块没过」只能从账本读。
  // 只要失败就常驻一个入口，别让用户靠翻日志找哪个模块没编出来。
  const failedModules = (compileResult?.modules ?? []).filter((m) => m.status === "failed");
  const blockedModules = (compileResult?.modules ?? []).filter((m) => m.status === "blocked");

  return (
    <>
      {compiling && (
        <button
          type="button"
          className="wb-status-chip"
          data-tone="busy"
          title={
            progress
              ? `${progress.phase}${progress.module ? ` · ${progress.module}` : ""} · 点击查看编译输出`
              : "编译进行中 · 点击查看编译输出"
          }
          onClick={() => openPanel("build")}
        >
          <span className="wb-status-dot" data-tone="busy" />
          {progress && progress.total > 0 ? `编译中 ${progress.done}/${progress.total}` : "编译中…"}
        </button>
      )}
      {!compiling && (failedModules.length > 0 || blockedModules.length > 0) && (
        <button
          type="button"
          className="wb-status-chip"
          data-tone="bad"
          title={
            failedModules.length > 0
              ? `编译失败：${failedModules.map((m) => m.module).join("、")}`
              : `被依赖模块阻断：${blockedModules.map((m) => m.module).join("、")}`
          }
          onClick={() => openPanel("build")}
        >
          {failedModules.length > 0
            ? `${failedModules.length} 个模块失败`
            : `${blockedModules.length} 个模块被阻断`}
        </button>
      )}
      {(errors > 0 || warnings > 0) && (
        <button
          type="button"
          className="wb-status-chip"
          data-tone={errors > 0 ? "bad" : "warn"}
          title="点击打开问题面板"
          onClick={() => openPanel("problems")}
        >
          {errors > 0 && (
            <span className="wb-status-num">
              <Icon name="alert" size={11} />
              {errors}
            </span>
          )}
          {warnings > 0 && (
            <span className="wb-status-num">
              <Icon name="alertTriangle" size={11} />
              {warnings}
            </span>
          )}
        </button>
      )}
      {activeTool === "files" && root && (
        <button
          type="button"
          className="wb-status-chip"
          title="多工程依赖链 / 覆盖规则 / 产物检查"
          data-priority="secondary"
          onClick={() => openLinkedDialog("chain")}
        >
          <Icon name="plug" size={11} />
          工程关联
        </button>
      )}
      {svnOn && ready && (
        <span
          className="wb-status-chip"
          title={`扫描了 ${ready.scanned} 个条目 · ${new Date(ready.generatedAtMs).toLocaleTimeString()}`}
        >
          改动 {ready.changes.shown}
          {ready.changes.ignored > 0 ? ` · 忽略 ${ready.changes.ignored}` : ""}
        </span>
      )}
      {svnOn && !ready && svn.isFetching && (
        <span className="wb-status-chip" data-tone="busy">
          <span className="wb-status-dot" data-tone="busy" />
          扫描改动中…
        </span>
      )}
      {svnOn && ready && svn.isFetching && (
        <span className="wb-status-chip" data-tone="busy" title="正在重新扫描工作副本">
          更新中…
        </span>
      )}
      {svnOn && info.data && (
        <span className="wb-status-chip" title={`${info.data.url} · ${info.data.user ?? "未登录"}`}>
          r{info.data.revision}
        </span>
      )}
      {activeTool === "db" && db && (
        <>
          <span
            className="wb-status-chip"
            data-tone={db.status === "error" ? "bad" : db.status === "connected" ? "ok" : "busy"}
            title={`当前连接：${db.name}`}
          >
            <span className="wb-status-dot" data-tone={db.status === "connected" ? "ok" : db.status === "error" ? "bad" : "idle"} />
            数据库 · {db.name}
          </span>
          {db.running && (
            <span className="wb-status-chip" data-tone="busy">
              查询中…
            </span>
          )}
          {db.pending.length > 0 && (
            <Menu portal align="right" width="w-80" trigger={(open, toggle) => (
              <button type="button" className="wb-status-chip" data-tone="warn" aria-haspopup="menu" aria-expanded={open} title="选择一个会话查看；各会话需要分别提交或回滚" onClick={toggle}>
                {db.pending.length} 个会话待提交
              </button>
            )}>
              {(close) => db.pending.map((session) => (
                <MenuItem key={session.slot ?? "primary"} label={`${session.label} · ${session.statements} 条未提交`} icon="alertTriangle" onClick={() => { close(); locateSession(session); }} />
              ))}
            </Menu>
          )}
        </>
      )}
      {primaryConn && <PrimarySessionSummary connId={primaryConn} onClose={() => setPrimaryConn(null)} />}
    </>
  );
}

/** 切回代码页并翻出底部面板的对应标签（问题 / 编译输出都住在那里）。 */
function openPanel(tab: "problems" | "build"): void {
  setSession({ panelOpen: true, panelTab: tab });
  window.dispatchEvent(new CustomEvent("ncforge-navigate", { detail: "files" }));
}
