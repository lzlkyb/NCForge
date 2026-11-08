import { servicePollInterval } from "../../lib/servicePolling";
import { useMemo } from "react";
import { DockRegion } from "../workspace/WorkbenchDock";
import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import "../../services.css";
import "../../service-console.css";
import { Icon } from "../ui/icon";
import { ServiceActionsBar } from "../services/ServiceActionsBar";
import { toast } from "../ui/toast";
import { ServiceRunToolbar } from "../services/ServiceRunToolbar";
import { ServiceLogSection } from "../services/ServiceLogSection";
import { ServiceConfig } from "../services/ServiceConfig";
import { CommandLineDialog } from "../services/CommandLineDialog";
import { PortDialog } from "../services/PortDialog";
import { ServiceConfirms } from "../services/ServiceConfirms";
import { ServiceAlerts } from "../services/ServiceAlerts";
import { MetaDeployCard } from "../services/MetaDeployCard";
import { ServiceNavigator, type ServiceDrawer } from "../services/ServiceNavigator";
import { ServiceDetails } from "../services/ServiceDetails";
import { ServiceDrawerPanel } from "../services/ServiceDrawerPanel";
import { DevelopmentFlowProgress } from "../services/DevelopmentFlowProgress";
import { useDevelopmentFlow } from "../../hooks/useDevelopmentFlow";
import { cancelDevelopmentFlow } from "../../lib/developmentFlowSession";
import { useServiceCommands } from "../../hooks/useServiceCommands";
import { useClientService } from "../../hooks/useClientService";
import { useAppHidden } from "../../lib/appVisibility";
import { useWorkspaceSelector } from "../../lib/workspaceSession";
import { errorToast } from "../../lib/errorToast";
import { attachDebugger, detachDebugger, useDebugSnapshot } from "../../lib/debugSession";
import { readDebugModePref, writeDebugModePref } from "../../lib/debugKeys";
import { serviceNames, type ServiceSource } from "../../lib/servicePresentation";
import { serverCommandLine, serverRevealLog, serverStatus, type LaunchPreview, type ServerState, type ServerStatus } from "../../lib/server";

interface PanelUi {
  source: ServiceSource;
  drawer: ServiceDrawer | null;
  confirm: { kind: "stop" | "kill" | "restart"; source: ServiceSource } | null;
  preview: LaunchPreview | null;
  previewing: boolean;
  portOpen: boolean;
}
/** 服务选择、生命周期操作与日志共享当前对象；其余信息在按需详情中展示。 */
export function ServicesTab({ onNavigate }: { onNavigate: (tab: string) => void }) {
  const appHidden = useAppHidden();
  const queryClient = useQueryClient();
  const panelOpen = useWorkspaceSelector(s => s.panelOpen);
  const panelTab = useWorkspaceSelector(s => s.panelTab);
  const svcVisible = panelOpen && panelTab === "svc";
  const [ui, setUi] = useState<PanelUi>({ source: "middleware", drawer: null, confirm: null, preview: null, previewing: false, portOpen: false });
  const changeUi = useCallback((patch: Partial<PanelUi>) => setUi(old => ({ ...old, ...patch })), []);
  const [generation, setGeneration] = useState(0);
  const bumpGeneration = useCallback(() => setGeneration(g => g + 1), []);
  const [debugMode, setDebugMode] = useState(readDebugModePref);
  const debug = useDebugSnapshot();
  const pollInterval = useMemo(servicePollInterval, []);
  const query = useQuery({ queryKey: ["server-status"], queryFn: serverStatus, refetchInterval: appHidden || !svcVisible ? false : pollInterval, retry: false });
  const { data: status, refetch, isError, error } = query;
  const patchState = useCallback((next: ServerState) => {
    queryClient.setQueryData<ServerStatus>(["server-status"], old => old ? { ...old, state: next } : old);
  }, [queryClient]);
  const clearConfirm = useCallback(() => changeUi({ confirm: null }), [changeUi]);
  const commands = useServiceCommands({ debugMode, refetch, patchState, onGeneration: bumpGeneration, onClearConfirm: clearConfirm });
  const client = useClientService({ visible: svcVisible, appHidden });
  const flow = useDevelopmentFlow();
  const selected = ui.source === "client" ? client.status : status ?? null;
  const selectedFailed = ui.source === "client" ? client.isError : isError;
  const selectedBusy = ui.source === "client" ? client.busy : commands.busy;
  const selectedError = ui.source === "client" ? client.error : error;
  const selectedDebug = debug.targets[ui.source === "client" ? "client" : "server"];
  const launchElapsed = selected?.launchStartedAtMs ? Math.max(0, Date.now() - selected.launchStartedAtMs) : selected?.uptimeMs;

  const attachDebug = (detach: boolean) => {
    const target = ui.source === "client" ? "client" : "server";
    void (detach ? detachDebugger(target) : attachDebugger(target)).then(() => toast(`${serviceNames[ui.source]}调试已${detach ? "断开" : "附加"}`, "success")).catch(e => errorToast(`${detach ? "断开" : "附加"}调试器`, e));
  };
  const showCommandLine = async () => {
    if (ui.source === "client") { await client.showCommandLine(); return; }
    changeUi({ previewing: true });
    try { changeUi({ preview: await serverCommandLine() }); }
    catch (e) { errorToast("生成启动命令行", e); }
    finally { changeUi({ previewing: false }); }
  };
  const revealLog = (previous = false) => { void serverRevealLog(previous).catch(e => errorToast("打开日志位置", e)); };
  const requestStop = () => {
    if (flow.running) void cancelDevelopmentFlow().catch(e => errorToast("取消开发流程", e));
    // 准备期间直接取消；已有运行进程的停止保留对象明确的确认。
    if (selectedBusy === "start" || selectedBusy === "restart" || selected?.state === "starting") { void (ui.source === "client" ? client.stop() : commands.stop()); return; }
    changeUi({ confirm: { kind: "stop", source: ui.source } });
  };
  const confirmAction = (kind: "stop" | "restart") => {
    const target = ui.confirm?.source;
    clearConfirm();
    if (target === "client") void (kind === "stop" ? client.stop() : client.restart());
    else void (kind === "stop" ? commands.stop() : commands.restart());
  };
  const tools = <ServiceActionsBar configOpen={ui.drawer === "config"} onToggleConfig={() => changeUi({ drawer: "config" })}
    previewing={ui.source === "client" ? client.previewing : ui.previewing} onCommandLine={() => void showCommandLine()}
    onRevealLog={ui.source === "client" ? client.revealLog : revealLog} known={!!selected && !selectedFailed} failed={selectedFailed}
    onRetryStatus={() => void (ui.source === "client" ? client.refetch() : refetch())}
    onDetails={() => changeUi({ drawer: "details" })} onDeploy={() => changeUi({ drawer: "deploy" })} />;
  const toolbarProps = { status: selected, busy: selectedBusy, failed: selectedFailed,
    debugMode: ui.source === "client" ? client.debugMode : debugMode,
    onStart: (forceDebug?: boolean) => {
      if (ui.source === "client") void client.start(forceDebug);
      else { if (forceDebug !== undefined) { setDebugMode(forceDebug); writeDebugModePref(forceDebug); } void commands.start(forceDebug); }
    }, onStop: requestStop, onRestart: () => changeUi({ confirm: { kind: "restart", source: ui.source } }),
    onRetry: () => void (ui.source === "client" ? client.refetch() : refetch()), debugAttached: selectedDebug.state === "attached", debugBusy: selectedDebug.busy !== null,
    onAttachDebug: () => attachDebug(false), onDetachDebug: () => attachDebug(true), workflowBusy: flow.running, tools };
  const drawerTitle = ui.drawer === "details" ? `${serviceNames[ui.source]} · 运行详情` : ui.drawer === "config" ? "中间件与客户端 · 启动设置" : "元数据投送";
  return <>
    <DockRegion region="bottom"><div className="sc-panel">
      {/* 保持工具栏与来源按钮挂载，方向键切换后焦点仍留在当前来源。 */}
      <ServiceRunToolbar {...toolbarProps} source={ui.source} navigator={<ServiceNavigator source={ui.source} onSource={source => changeUi({ source, drawer: null })}
        middleware={{ status: status ?? null, busy: commands.busy, failed: isError }} client={{ status: client.status, busy: client.busy, failed: client.isError }} />} />
      <section className="sc-console" id="sc-service-console" role="tabpanel" aria-labelledby={`sc-service-${ui.source}`}>
        <DevelopmentFlowProgress />
        {selectedFailed && <div className="sc-feedback" data-tone="warn"><Icon name="alertTriangle" size={14} /><span title={String(selectedError)}>读取服务状态失败，当前运行状态未知。请重试或查看日志。</span><button type="button" className="sv-btn" onClick={toolbarProps.onRetry}>重试</button></div>}
        {!selectedFailed && selected?.state === "starting" && <div className="sc-feedback" data-tone="waiting"><Icon name="spinner" className="animate-spin" size={13} /><span>{selected.launchPhase || (selected.pid ? "JVM 已创建，正在等待运行状态" : "正在准备启动")}</span>{launchElapsed !== null && launchElapsed !== undefined && <small>已用 {Math.floor(launchElapsed / 1000)} 秒</small>}<button type="button" className="sv-btn" onClick={() => changeUi({ drawer: "details" })}>运行详情</button></div>}
        {!selectedFailed && selected?.state === "stopped" && selected.reason && <div className="sc-feedback" data-tone={selected.exitCode ? "bad" : "warn"}><Icon name="info" size={13} /><span>{selected.reason}{selected.exitCode !== null ? ` · 退出码 ${selected.exitCode}` : ""}</span></div>}
        {ui.source === "middleware" && <ServiceAlerts status={isError ? null : status ?? null} busy={commands.busy !== null || isError} onKill={() => changeUi({ confirm: { kind: "kill", source: "middleware" } })} onNavigate={onNavigate} />}
        <ServiceLogSection source={ui.source} appHidden={appHidden} middleware={{ active: !status || status.state === "running" || status.state === "starting", generation, runId: status?.runId, visible: svcVisible, projectRoot: status?.projectRoot, logPath: status?.logPath ?? "", logSize: status?.logSize ?? 0, onReveal: revealLog, onCleared: () => void refetch() }}
          client={{ active: !client.status || client.status.state === "running" || client.status.state === "starting", generation: client.generation, runId: client.status?.runId, visible: svcVisible, projectRoot: client.status?.projectRoot, logPath: client.status?.logPath ?? "", logSize: client.status?.logSize ?? 0, onReveal: client.revealLog, onCleared: () => void client.refetch() }} />
      </section>
      {ui.drawer && <ServiceDrawerPanel title={drawerTitle} onClose={() => changeUi({ drawer: null })}>
        {ui.drawer === "details" && <ServiceDetails source={ui.source} status={selected} failed={selectedFailed} onCommandLine={() => void showCommandLine()} onEditPort={() => changeUi({ portOpen: true })} />}
        {ui.drawer === "config" && <><div className="sc-start-options"><label><input type="checkbox" checked={debugMode} onChange={e => { setDebugMode(e.target.checked); writeDebugModePref(e.target.checked); }} />中间件下次启动带调试</label><label><input type="checkbox" checked={client.debugMode} onChange={client.toggleDebugMode} />客户端下次启动带调试</label></div><ServiceConfig status={status ?? null} running={!status || status.state !== "stopped"} clientStatus={client.status} clientRunning={!client.status || client.status.state !== "stopped"} onRefetch={() => void refetch()} onRefetchClient={() => void client.refetch()} /></>}
        {ui.drawer === "deploy" && <MetaDeployCard defaultOpen />}
      </ServiceDrawerPanel>}
    </div></DockRegion>
    <ServiceConfirms confirm={ui.confirm?.kind ?? null} target={ui.confirm?.source} port={status?.port ?? 80} ownerName={status?.portOwner?.name} ownerPid={status?.portOwner?.pid} onCancel={clearConfirm} onConfirmStop={() => confirmAction("stop")} onConfirmRestart={() => confirmAction("restart")} onConfirmKill={() => void commands.killOwner()} />
    <CommandLineDialog preview={ui.preview} onClose={() => changeUi({ preview: null })} />
    <CommandLineDialog preview={client.preview} onClose={client.closePreview} kind="client" />
    <PortDialog open={ui.portOpen} currentPort={status?.port ?? 80} onClose={() => changeUi({ portOpen: false })} onApplied={() => void refetch()} />
  </>;
}
