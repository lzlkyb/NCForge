import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import "../../services.css";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { ServiceCard } from "../services/ServiceCard";
import { LogPanel } from "../services/LogPanel";
import { PathField } from "../services/PathField";
import { CommandLineDialog } from "../services/CommandLineDialog";
import { PortDialog } from "../services/PortDialog";
import { HeapField } from "../services/HeapField";
import { ServiceConfirms } from "../services/ServiceConfirms";
import { useAppHidden } from "../../lib/appVisibility";
import { setWorkspace } from "../../lib/workspace";
import {
  ncHomeProbe,
  ncHomeSet,
  serverCommandLine,
  serverKillPortOwner,
  serverRevealLog,
  serverHeapSet,
  serverStart,
  serverStatus,
  serverStop,
  type LaunchPreview,
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
  const queryClient = useQueryClient();
  const appHidden = useAppHidden();
  const [busy, setBusy] = useState<Busy>(null);
  const [confirm, setConfirm] = useState<null | "stop" | "kill">(null);
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

  // NC home 只探测一次就够（换目录时用 setQueryData 覆盖）
  const probe = useQuery({
    queryKey: ["nc-home"],
    queryFn: () => ncHomeProbe(),
    staleTime: 30_000,
    retry: false,
  });

  const start = useCallback(async () => {
    setBusy("start");
    try {
      await serverStart();
      setGeneration((g) => g + 1);
      toast("已启动，正在加载模块（通常 10 秒左右）", "success");
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(null);
      void refetch();
    }
  }, [refetch]);

  const stop = useCallback(async () => {
    setConfirm(null);
    setBusy("stop");
    try {
      // 三态而不是布尔：准备启动那一秒里点停止，进程还不存在，只能说「正在取消」。
      // 一律报「已停止」是最坑的——服务随后照旧起来，用户以为自己停了。
      const outcome = await serverStop();
      if (outcome === "stopped") toast("已停止", "success");
      else if (outcome === "cancelling") toast("正在取消启动…", "info");
      else toast("服务没有在运行", "info");
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(null);
      void refetch();
    }
  }, [refetch]);

  const restart = useCallback(async () => {
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
      toast("已重启，正在加载模块", "success");
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(null);
      void refetch();
    }
  }, [refetch]);

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
          onRestart={() => void restart()}
          onEditPort={() => setPortOpen(true)}
        />

        {conflict && owner && (
          <div className="sv-alert">
            <Icon name="alertTriangle" size={14} />
            <span className="sv-alert-text">
              端口 {status?.port} 被 <b>{owner.name}</b>（PID {owner.pid}）占用
              {ownerIsJava
                ? "，可能是上次没停干净的 NC 中间件。"
                : "，它不是 java 进程，本工具不会替你结束它。"}
            </span>
            {ownerIsJava && (
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

        {probe.error && (
          <div className="sv-alert" data-tone="warn">
            <Icon name="info" size={14} />
            <span className="sv-alert-text">找不到 NC 安装目录：{String(probe.error)}</span>
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

        <div className="sv-cfg">
          <PathField
            label="NC home"
            value={probe.data?.root ?? status?.ncHome ?? ""}
            placeholder="D:\ncc\1909home"
            hint={probe.data ? `${probe.data.moduleCount} 个模块` : undefined}
            onSave={async (v) => {
              const home = await ncHomeSet(v);
              queryClient.setQueryData(["nc-home"], home);
              void refetch();
            }}
          />
          <span className="sv-cfg-sep" />
          <PathField
            label="工程"
            value={status?.projectRoot ?? ""}
            placeholder="C:\work\aier\newar"
            hint={status?.projectRoot ? "改完代码编译后重启即生效" : "未选择"}
            onSave={async (v) => {
              const shown = await setWorkspace(v);
              toast(`工程已切换为 ${shown}`, "success");
              void refetch();
            }}
          />
          {/* 堆上限：状态里带的是「后端收口后真正会写进命令行」的值，
              界面上显示生效值而不是配置原值——手改过 config.json 的人才不会被骗 */}
          {status && (
            <>
              <span className="sv-cfg-sep" />
              <HeapField
                heapMb={status.heapMb}
                defaultHeapMb={status.defaultHeapMb}
                running={state !== "stopped"}
                onSave={async (mb) => {
                  const applied = await serverHeapSet(mb);
                  await refetch();
                  return applied;
                }}
              />
            </>
          )}
        </div>

        <LogPanel
          active={state === "running" || state === "starting"}
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
