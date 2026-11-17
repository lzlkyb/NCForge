import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { toast } from "../components/ui/toast";
import type { TauriCommand } from "./commandContract.generated";
import { toIpcError } from "./ipcError";

/**
 * `args` 允许直接传 `Uint8Array` / `ArrayBuffer`：Tauri 会把整个载荷当**裸字节**投递给
 * Rust（命令侧用 `tauri::ipc::Request` 取 `InvokeBody::Raw`）。几 MB 的文件如果按
 * `{ bytes: [...] }` 传，会被编成上千万个数字字符——这条路省掉那次编解码。
 * 代价：裸载荷时命令**不能带其它参数**（载荷就是参数本身）。
 *
 * 失败一律经 `toIpcError` 归一：结构化错误（新命令）包成 `Error` 实例，
 * 字符串错误（存量命令）原样抛。少了这一步，新命令的错误会以裸对象抵达调用方，
 * 所有 `String(e)` 当场变成 `[object Object]`。
 */
export async function invoke<T>(
  cmd: TauriCommand,
  args?: Record<string, unknown> | ArrayBuffer | Uint8Array,
): Promise<T> {
  try {
    return await tauriInvoke<T>(cmd, args as Record<string, unknown>);
  } catch (e) {
    throw toIpcError(e);
  }
}

/**
 * 统一 invoke 包装（④P2-10）：fire-and-forget 风格，失败时自动弹 toast 错误并吞掉异常，
 * 调用点无需 try/catch。用于原 `.catch(console.error)` 静默失败的落盘/打开类调用。
 * 成功返回 T，失败返回 undefined（已 toast）。
 *
 * toast 正文不用 `${e}`：后者对 `Error` 会多出 `Error: ` 前缀，同一条错误在
 * `invoke` 与 `invokeOrToast` 两条路上长得不一样。也**刻意不 import `friendlyError`**：
 * 它依赖 `db.ts` / `svn.ts`，那两个又会 import 本文件，绕成循环依赖。
 */
export async function invokeOrToast<T>(
  cmd: TauriCommand,
  args?: Record<string, unknown>,
  errMsg?: string,
): Promise<T | undefined> {
  try {
    return await tauriInvoke<T>(cmd, args);
  } catch (raw) {
    const e = toIpcError(raw);
    const text = e instanceof Error ? e.message : String(e);
    toast(errMsg ?? `${cmd} 失败：${text}`, "error");
    return undefined;
  }
}

export async function listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  return tauriListen<T>(event, (e) => handler(e.payload as T));
}
