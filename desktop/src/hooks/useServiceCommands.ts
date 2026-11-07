import { useRef, useState } from "react";
import { serverKillPortOwner, serverStart, serverStop, type ServerState } from "../lib/server";
import { toast } from "../components/ui/toast";
import { errorToast } from "../lib/errorToast";
import { useServiceActions } from "./useServiceActions";
interface Options { debugMode: boolean; refetch: () => Promise<unknown>; patchState: (next: ServerState) => void; onGeneration: () => void; onClearConfirm: () => void; }
export function useServiceCommands(options: Options) {
  const [killing, setKilling] = useState(false);
  const killLock = useRef(false);
  const actions = useServiceActions({ ...options, name: "中间件", startRequest: serverStart, stopRequest: serverStop, blocked: () => killLock.current });
  const killOwner = async () => {
    if (killLock.current || actions.isPending()) return;
    killLock.current = true;
    setKilling(true);
    options.onClearConfirm();
    try { toast(`已结束 PID ${await serverKillPortOwner()}`, "success"); }
    catch (e) { errorToast("结束占用端口的进程", e); }
    finally { killLock.current = false; setKilling(false); void options.refetch(); }
  };
  return { ...actions, busy: killing ? "kill" as const : actions.busy, killOwner };
}
