import { useCallback, useRef, useState } from "react";
import { serverKillPortOwner, serverStart, serverStop, type ServerState } from "../lib/server";
import { toast } from "../components/ui/toast";
import { failureText } from "../lib/friendlyError";
type Busy = "start" | "stop" | "restart" | "kill" | null;
interface Options { debugMode: boolean; refetch: () => Promise<unknown>; patchState: (next: ServerState) => void; onGeneration: () => void; onClearConfirm: () => void; }
/** 同帧同步锁覆盖整次服务动作；渲染 busy 只用于反馈，无法独自防连点。 */
export function useServiceCommands({ debugMode, refetch, patchState, onGeneration, onClearConfirm }: Options) {
  const [busy, setBusy] = useState<Busy>(null);
  const lock = useRef(false);
  const start = useCallback(async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy("start");
    try {
      await serverStart(debugMode);
      onGeneration();
      patchState("starting");
      toast(
        debugMode
          ? "调试启动请求已接受，正在加载模块；监听就绪后可附加调试器"
          : "启动请求已接受，正在加载模块，等待监听端口就绪",
        "success",
      );
    } catch (e) {
      toast(failureText("启动服务", e), "error");
      // 后端把「启动失败：…」写进了日志文件，面板还停在上一代：不换一代的话，
      // 失败详情既看不到、下次成功启动又被轮转成 .1 更难找
      onGeneration();
    } finally {
      lock.current = false;
      setBusy(null);
      void refetch();
    }
  }, [refetch, patchState, debugMode, onGeneration]);

  const stop = useCallback(async () => {
    if (lock.current) return;
    lock.current = true;
    onClearConfirm();
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
      toast(failureText("停止服务", e), "error");
    } finally {
      lock.current = false;
      setBusy(null);
      void refetch();
    }
  }, [refetch, patchState, onClearConfirm]);

  const restart = useCallback(async () => {
    if (lock.current) return;
    lock.current = true;
    onClearConfirm();
    setBusy("restart");
    try {
      const outcome = await serverStop();
      if (outcome === "cancelling") {
        // 上一次启动还在写 pathing jar：现在起新的会被「上一次启动还没完成」挡回来
        toast("正在取消上一次启动，等一秒再点重启", "warning");
        return;
      }
      await serverStart(debugMode);
      onGeneration();
      patchState("starting");
      // 停止时服务已经自己崩了（idle）：这次其实是全新启动，说清比笼统的「已重启」有用
      toast(
        outcome === "idle" ? "服务先前已退出，本次启动请求已接受" : "重启请求已接受，正在加载模块",
        "success",
      );
    } catch (e) {
      toast(failureText("重启服务", e), "error");
      onGeneration();
    } finally {
      lock.current = false;
      setBusy(null);
      void refetch();
    }
  }, [refetch, patchState, debugMode, onGeneration, onClearConfirm]);

  const killOwner = useCallback(async () => {
    if (lock.current) return;
    lock.current = true;
    onClearConfirm();
    setBusy("kill");
    try {
      const pid = await serverKillPortOwner();
      toast(`已结束 PID ${pid}`, "success");
    } catch (e) {
      toast(failureText("结束占用端口的进程", e), "error");
    } finally {
      lock.current = false;
      setBusy(null);
      void refetch();
    }
  }, [refetch, onClearConfirm]);

  return { busy, start, stop, restart, killOwner };
}
