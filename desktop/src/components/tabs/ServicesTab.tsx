import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import "../../services.css";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { ServiceCard } from "../services/ServiceCard";
import { LogPanel } from "../services/LogPanel";
import { ServiceConfig } from "../services/ServiceConfig";
import { CommandLineDialog } from "../services/CommandLineDialog";
import { PortDialog } from "../services/PortDialog";
import { ServiceConfirms } from "../services/ServiceConfirms";
import { useAppHidden } from "../../lib/appVisibility";
import {
  serverCommandLine,
  serverKillPortOwner,
  serverRevealLog,
  serverStart,
  serverStatus,
  serverStop,
  type LaunchPreview,
  type ServerState,
  type ServerStatus,
  UNKNOWN_PROCESS_NAME,
} from "../../lib/server";

type Busy = "start" | "stop" | "restart" | "kill" | null;

/**
 * NC 服务页：启停中间件 + 实时日志。
 *
 * 状态全部来自后端轮询（1 秒一次；窗口隐藏时停），前端不自己拼状态：
 * 「进程活着」不等于「服务可用」，后者要看中间件端口是不是我们的进程在监听。
 * 端口读自 NC 自己的 `ierp/bin/prop.xml`（见 `ServerStatus.port`），不写死 80。
 */
export function ServicesTab({ onNavigate }: { onNavigate: (tab: string) => void }) {
  const appHidden = useAppHidden();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<Busy>(null);
  const [confirm, setConfirm] = useState<null | "stop" | "kill" | "restart">(null);
  /** 每次启动 +1：让日志面板换一代（后端启动时把旧日志轮转成 .1）。 */
  const [generation, setGeneration] = useState(0);
  const [preview, setPreview] = useState<LaunchPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [portOpen, setPortOpen] = useState(false);

  const { data: status, refetch } = useQuery({
    queryKey: ["server-status"],
    queryFn: serverStatus,
    refetchInterval: appHidden ? false : 1000,
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

  const start = useCallback(async () => {
    setBusy("start");
    try {
      await serverStart();
      setGeneration((g) => g + 1);
      patchState("starting");
      toast("已启动，正在加载模块（通常 10 秒左右）", "success");
    } catch (e) {
      toast(String(e), "error");
      // 后端把「启动失败：…」写进了日志文件，面板还停在上一代：不换一代的话，
      // 失败详情既看不到、下次成功启动又被轮转成 .1 更难找
      setGeneration((g) => g + 1);
    } finally {
      setBusy(null);
      void refetch();
    }
  }, [refetch, patchState]);

  const stop = useCallback(async () => {
    setConfirm(null);
    setBusy("stop");
    try {
      // 三态而不是布尔：准备启动那一秒里点停止，进程还不存在，只能说「正在取消」。
      // 一律报「已停止」是最坑的——服务随后照旧起来，用户以为自己停了。
      const outcome = await serverStop();
      if (outcome === "stopped") {
        patchState("stopped");
        toast("已停止", "success");
      } else if (outcome === "cancelling") toast("正在取消启动…", "info");
      else toast("服务没有在运行", "info");
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(null);
      void refetch();
    }
  }, [refetch, patchState]);

  const restart = useCallback(async () => {
    setConfirm(null);
    setBusy("restart");
    try {
      const outcome = await serverStop();
      if (outcome === "cancelling") {
        // 上一次启动还在写 pathing jar：现在起新的会被「上一次启动还没完成」挡回来
        toast("正在取消上一次启动，等一秒再点重启", "warning");
        return;
      }
      await serverStart();
      setGeneration((g) => g + 1);
      patchState("starting");
      // 停止时服务已经自己崩了（idle）：这次其实是全新启动，说清比笼统的「已重启」有用
      toast(
        outcome === "idle" ? "服务先前已退出，本次是全新启动" : "已重启，正在加载模块",
        "success",
      );
    } catch (e) {
      toast(String(e), "error");
      setGeneration((g) => g + 1);
    } finally {
      setBusy(null);
      void refetch();
    }
  }, [refetch, patchState]);

  const killOwner = useCallback(async () => {
    setConfirm(null);
    setBusy("kill");
    try {
      const pid = await serverKillPortOwner();
      toast(`已结束 PID ${pid}`, "success");
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(null);
      void refetch();
    }
  }, [refetch]);

  const showCommandLine = async () => {
    setPreviewing(true);
    try {
      setPreview(await serverCommandLine());
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setPreviewing(false);
    }
  };

  const revealLog = () => {
    void serverRevealLog().catch((e) => toast(String(e), "error"));
  };

  const state = status?.state ?? "stopped";
  const owner = status?.portOwner ?? null;
  const conflict = !!owner && !status?.portOwnedBySelf;
  const ownerIsJava = !!owner && owner.name.toLowerCase().startsWith("java");
  // 读不到进程名时后端给的是占位值（Rust `server::UNKNOWN_PROCESS`，前端同名常量）。
  // 那不等于「不是 java」：早先这里一律落到「它不是 java 进程」，等于替用户
  // 下了一个我们并不知道的结论——而用户会据此去任务管理器里找一个「非 java」的进程。
  const ownerUnknown = !!owner && owner.name === UNKNOWN_PROCESS_NAME;

  return (
    <div className="sv-page">
      <div className="sv-head">
        <h1>NC 服务</h1>
        <span className="sv-sub">开发态中间件 · 改完代码重启即可生效</span>
        <span className="sv-sp" />
        <button type="button" className="sv-btn" disabled={previewing} onClick={() => void showCommandLine()}>
          <Icon name="terminal" size={13} />
          {previewing ? "生成中…" : "命令行"}
        </button>
        <button type="button" className="sv-btn" onClick={revealLog}>
          <Icon name="folder" size={13} />
          日志位置
        </button>
      </div>

      <div className="sv-body">
        <ServiceCard
          status={status ?? null}
          busy={busy}
          onStart={() => void start()}
          onStop={() => setConfirm("stop")}
          onRestart={() => setConfirm("restart")}
          onEditPort={() => setPortOpen(true)}
        />

        {conflict && owner && (
          <div className="sv-alert">
            <Icon name="alertTriangle" size={14} />
            <span className="sv-alert-text">
              端口 {status?.port} 被 <b>{owner.name}</b>（PID {owner.pid}）占用
              {ownerIsJava
                ? "，可能是上次没停干净的 NC 中间件。"
                : ownerUnknown
                  ? "，但读不到它的进程名——这不等于它不是 java。可以按 PID 在任务管理器里确认。"
                  : "，它不是 java 进程，本工具不会替你结束它。"}
            </span>
            {(ownerIsJava || ownerUnknown) && (
              <button
                type="button"
                className="sv-btn sv-btn-danger"
                disabled={busy !== null}
                onClick={() => setConfirm("kill")}
              >
                结束该进程
              </button>
            )}
          </div>
        )}

        {!status?.projectRoot && (
          <div className="sv-alert" data-tone="warn">
            <Icon name="info" size={14} />
            <span className="sv-alert-text">
              还没选工程目录：服务能起来，但你改的代码<b>不会生效</b>（用的全是 NC home 里的 jar）。
            </span>
            <button type="button" className="sv-btn" onClick={() => onNavigate("files")}>
              去选工程
            </button>
          </div>
        )}

        <ServiceConfig status={status ?? null} running={state !== "stopped"} onRefetch={() => void refetch()} />

        <LogPanel
          active={state === "running" || state === "starting"}
          appHidden={appHidden}
          generation={generation}
          logPath={status?.logPath ?? ""}
          logSize={status?.logSize ?? 0}
          onReveal={revealLog}
          onCleared={() => void refetch()}
        />
      </div>

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
    </div>
  );
}
