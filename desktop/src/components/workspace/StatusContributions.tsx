import { useQuery } from "@tanstack/react-query";
import { setSession, useWorkspaceSelector } from "../../lib/workspaceSession";
import { useCodeDiags } from "../../lib/diagStore";
import { countErrors, mergeProblems } from "../../lib/problemList";
import { svnInfo, svnStatus } from "../../lib/svn";
import { connOf, rtOf, useDbSelector } from "../../lib/dbStore";
import { Icon } from "../ui/icon";

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
  const compiling = useWorkspaceSelector((s) => s.compiling);
  const compileResult = useWorkspaceSelector((s) => s.compileResult);
  const diags = useCodeDiags();

  const svnOn = activeTool === "svn";
  const svn = useQuery({
    queryKey: ["svn-status"],
    queryFn: svnStatus,
    enabled: svnOn,
    staleTime: 30_000,
    retry: false,
  });
  const info = useQuery({
    queryKey: ["svn-info"],
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
        name: connOf(tab.connId)?.name ?? "数据库",
        status: rt.status,
        pending: rt.tx?.statements ?? 0,
        running: s.tabs.some((t) => t.kind === "sql" && t.running),
      };
    },
    (a, b) =>
      a === b ||
      (!!a && !!b && a.name === b.name && a.status === b.status && a.pending === b.pending && a.running === b.running),
  );

  const problems = mergeProblems(compileResult?.problems, diags);
  const errors = countErrors(problems);
  const warnings = problems.filter((p) => p.severity === "warning").length;
  const ready = svn.data;

  return (
    <>
      {compiling && (
        <button
          type="button"
          className="wb-status-chip"
          data-tone="busy"
          title="编译进行中 · 点击查看编译输出"
          onClick={() => openPanel("build")}
        >
          <span className="wb-status-dot" data-tone="busy" />
          编译中…
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
          {db.pending > 0 && (
            <span className="wb-status-chip" data-tone="warn" title="这些语句还没提交，断开连接会丢失">
              事务 {db.pending} 条未提交
            </span>
          )}
        </>
      )}
    </>
  );
}

/** 切回代码页并翻出底部面板的对应标签（问题 / 编译输出都住在那里）。 */
function openPanel(tab: "problems" | "build"): void {
  setSession({ panelOpen: true, panelTab: tab });
  window.dispatchEvent(new CustomEvent("ncforge-navigate", { detail: "files" }));
}
