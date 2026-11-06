import { useEffect, useRef, useState } from "react";
import { serviceLogClear, serviceLogExport, serviceLogExportText, type ServiceLogTarget } from "../lib/serviceConsoleApi";
import { toast } from "../components/ui/toast";

interface Options { target: ServiceLogTarget; previous: boolean; fileId?: string; reset: (offset: number) => void; onCleared: () => void; }
export function useServiceLogActions({ target, previous, fileId, reset, onCleared }: Options) {
  const [busy, setBusy] = useState<string | null>(null);
  const lock = useRef(false), controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const run = async (label: string, action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(label);
    try { await action(); } catch (error) { toast(`${label}失败：${String(error)}`, "error"); }
    finally { lock.current = false; controller.current = null; setBusy(null); }
  };
  const copy = (text: string, label: string) => {
    if (!text) return;
    void run("复制日志", async () => { await navigator.clipboard.writeText(text); toast(`已复制${label}`, "success"); });
  };
  const clear = () => {
    if (previous) return;
    void run("清屏", async () => { const result = await serviceLogClear(target); reset(result.offset); onCleared(); toast("已清屏，磁盘日志文件保留", "info"); });
  };
  const exportLog = (text?: string) => {
    void run("导出日志", async () => {
      controller.current = new AbortController();
      const result = text === undefined ? await serviceLogExport(target, previous, fileId, controller.current.signal) : await serviceLogExportText(target, previous, text, controller.current.signal);
      if (result) toast(`日志已保存：${result.path}`, "success");
    });
  };
  return { busy, copy, clear, exportLog, cancel: () => controller.current?.abort() };
}
