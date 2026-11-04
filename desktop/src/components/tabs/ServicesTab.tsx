import { DockRegion } from "../workspace/WorkbenchDock";
import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import "../../services.css";
import { Icon } from "../ui/icon";
import { ServiceActionsBar } from "../services/ServiceActionsBar";
import { toast } from "../ui/toast";
import { ServiceCard } from "../services/ServiceCard";
import { LogPanel } from "../services/LogPanel";
import { ServiceConfig } from "../services/ServiceConfig";
import { CommandLineDialog } from "../services/CommandLineDialog";
import { PortDialog } from "../services/PortDialog";
import { ServiceConfirms } from "../services/ServiceConfirms";
import { ServiceAlerts } from "../services/ServiceAlerts";
import { MetaDeployCard } from "../services/MetaDeployCard";
import { useServiceCommands } from "../../hooks/useServiceCommands";
import { useAppHidden } from "../../lib/appVisibility";
import { useWorkspaceSelector } from "../../lib/workspaceSession";
import { failureText } from "../../lib/friendlyError";
import { attachDebugger, detachDebugger, useDebugSnapshot } from "../../lib/debugSession";
import { readDebugModePref, writeDebugModePref } from "../../lib/debugKeys";
import {
  serverCommandLine,
  serverRevealLog,
  serverStatus,
  type LaunchPreview,
  type ServerState,
  type ServerStatus,
} from "../../lib/server";

/**
 * NC 服务面板：启停中间件 + 实时日志。
 *
 * 不再是主导航页签：内容常驻在文件页底部面板的「NC 服务」标签里，状态栏的
 * 服务胶囊和命令面板都能直接打开它。组件始终挂载，但只在面板可见时 1 秒轮询。
 *
 * 状态全部来自后端轮询，前端不自己拼状态：「进程活着」不等于「服务可用」，
 * 后者要看中间件端口是不是我们的进程在监听。端口读自 NC 自己的
 * `ierp/bin/prop.xml`（见 `ServerStatus.port`），不写死 80。
 */
export function ServicesTab({ onNavigate }: { onNavigate: (tab: string) => void }) {
  const appHidden = useAppHidden();
  const queryClient = useQueryClient();
  const panelOpen = useWorkspaceSelector((s) => s.panelOpen);
  const panelTab = useWorkspaceSelector((s) => s.panelTab);
  const svcVisible = panelOpen && panelTab === "svc";
  const [confirm, setConfirm] = useState<null | "stop" | "kill" | "restart">(null);
  /** 每次启动 +1：让日志面板换一代（后端启动时把旧日志轮转成 .1）。 */
  const [generation, setGeneration] = useState(0);
  const [preview, setPreview] = useState<LaunchPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [portOpen, setPortOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  /** 下次启动是否带 JDWP。持久化在 localStorage：常做二次开发的人不必每次勾。 */
  const [debugMode, setDebugMode] = useState(readDebugModePref);
  const debug = useDebugSnapshot();

  const { data: status, refetch, isError, error } = useQuery({
    queryKey: ["server-status"],
    queryFn: serverStatus,
    // 面板不可见时不必每秒问一次：状态栏胶囊另有 5 秒轮询兜着
    refetchInterval: appHidden || !svcVisible ? false : 1000,
    retry: false,
  });

  /**
   * 成功之后先把状态按预期写进缓存，别等下一次 1 秒轮询。
   *
   * 两个地方会骗人：轮询间隔那一秒里按钮还是旧状态（显示「已停止」+ 可点的「启动」，
   * 点下去被后端拒）；首屏 status 没回来时默认「已停止」还会闪一帧。
   */
  const patchState = useCallback(
    (next: ServerState) => {
      queryClient.setQueryData<ServerStatus>(["server-status"], (old) =>
        old ? { ...old, state: next } : old,
      );
    },
    [queryClient],
  );

  const { busy, start, stop, restart, killOwner } = useServiceCommands({
    debugMode, refetch, patchState,
    onGeneration: () => setGeneration(g => g + 1), onClearConfirm: () => setConfirm(null),
  });

  const toggleDebugMode = () => {
    const next = !debugMode;
    setDebugMode(next);
    writeDebugModePref(next);
  };

  const attachDebug = () => {
    void attachDebugger()
      .then(() => toast("已附加调试器，命中断点后底部「调试」面板会自动打开", "success"))
      .catch((e) => toast(failureText("附加调试器", e), "error"));
  };

  const detachDebug = () => {
    void detachDebugger()
      .then(() => toast("已断开调试（服务继续运行）", "info"))
      .catch((e) => toast(failureText("断开调试", e), "error"));
  };

  const showCommandLine = async () => {
    setPreviewing(true);
    try {
      setPreview(await serverCommandLine());
    } catch (e) {
      toast(failureText("生成启动命令行", e), "error");
    } finally {
      setPreviewing(false);
    }
  };

  const revealLog = () => {
    void serverRevealLog().catch((e) => toast(failureText("打开日志位置", e), "error"));
  };

  // 三态：`status` 没回来或读失败时是 undefined。**不能**当成「已停止」——
  // 服务可能正在跑，而 `state` 决定日志要不要继续刷新、改配置要不要弹确认。
  // 早先 `?? "stopped"` 的写法会让日志面板显示「未在运行，不再刷新」，
  // 崩溃日志再也看不到，配置切换的确认也不弹。
  const state = status?.state;
  const known = state !== undefined;
  const owner = status?.portOwner ?? null;

  return (
    <>
      <DockRegion region="bottom"><div className="sv-body wb-service-tool">
        <ServiceActionsBar
          configOpen={configOpen}
          onToggleConfig={() => setConfigOpen((v) => !v)}
          previewing={previewing}
          onCommandLine={() => void showCommandLine()}
          onRevealLog={revealLog}
          known={known}
          failed={isError}
          onRetryStatus={() => void refetch()}
        />
        <ServiceCard
          status={status ?? null}
          busy={busy}
          failed={isError}
          onStart={() => void start()}
          onStop={() => setConfirm("stop")}
          onRestart={() => setConfirm("restart")}
          onEditPort={() => setPortOpen(true)}
          debugMode={debugMode}
          onToggleDebugMode={toggleDebugMode}
          debugAttached={debug.status.state === "attached"}
          debugBusy={debug.busy !== null}
          onAttachDebug={attachDebug}
          onDetachDebug={detachDebug}
        />

        {isError && (
          <div className="sv-alert" data-tone="warn">
            <Icon name="alertTriangle" size={14} />
            <span className="sv-alert-text">
              读取服务状态失败：{String(error)}。上面的状态未知，不代表服务已停止——先重试，
              或直接去看日志确认真实情况。
            </span>
            <button type="button" className="sv-btn" onClick={() => void refetch()}>
              重试
            </button>
          </div>
        )}

        <ServiceAlerts
          status={status ?? null}
          busy={busy !== null}
          onKill={() => setConfirm("kill")}
          onNavigate={onNavigate}
        />

        {configOpen && <ServiceConfig status={status ?? null} running={!known || state !== "stopped"} onRefetch={() => void refetch()} />}
        <MetaDeployCard />

        <LogPanel
          active={!known || state === "running" || state === "starting"}
          appHidden={appHidden}
          generation={generation}
          logPath={status?.logPath ?? ""}
          logSize={status?.logSize ?? 0}
          onReveal={revealLog}
          onCleared={() => void refetch()}
        />
      </div></DockRegion>

      <ServiceConfirms
        confirm={confirm}
        port={status?.port ?? 80}
        ownerName={owner?.name}
        ownerPid={owner?.pid}
        onCancel={() => setConfirm(null)}
        onConfirmStop={() => void stop()}
        onConfirmRestart={() => void restart()}
        onConfirmKill={() => void killOwner()}
      />

      <CommandLineDialog preview={preview} onClose={() => setPreview(null)} />

      <PortDialog
        open={portOpen}
        currentPort={status?.port ?? 80}
        onClose={() => setPortOpen(false)}
        onApplied={() => void refetch()}
      />
    </>
  );
}
