/**
 * 后端结构化错误 → 前端 `Error` 实例。
 *
 * ## 为什么必须在 invoke 层包一次
 *
 * `AppError`（见 `src-tauri/src/app_error.rs`）序列化成 `{code, class, detail}`
 * **对象**过 IPC。但项目里几乎所有 `catch` 分支都是按「字符串或 Error」写的：
 * `String(e)`、`e.message`、`friendlyError(e)`。裸对象进来会让 `String(e)` 变成
 * `[object Object]`，错误信息当场消失——比不改还糟，而且不会报任何错。
 *
 * 所以：对象转成 `Error` 子类（`message = detail`），字符串与既有 `Error` 原样透传。
 * 这样 `String(e)` 仍可读、`instanceof Error` 成立、`code` 也留得住。
 *
 * ## 两条并存是刻意的
 *
 * 存量 400 多条命令仍返 `String`，新命令返 `AppError`。判断只看**形状**，不看到底
 * 是哪条命令——否则前端要维护一份「哪些命令已迁移」的清单，和维护命令契约一样脆。
 */

export type IpcErrorClass = "input" | "environment" | "unavailable" | "data" | "internal";

const CLASSES: readonly IpcErrorClass[] = ["input", "environment", "unavailable", "data", "internal"];

export interface RawAppError {
  code: string;
  class: IpcErrorClass;
  detail: string;
  hint?: string;
}

/**
 * 后端错误的 JS 形态。
 *
 * `name` 固定成 `IpcError` 而不是 `Error`：控制台里一眼能分出「后端返回的」
 * 和「前端自己抛的」。
 */
export class IpcError extends Error {
  readonly code: string;
  readonly class: IpcErrorClass;
  readonly hint?: string;

  constructor(raw: RawAppError) {
    super(raw.detail);
    this.name = "IpcError";
    this.code = raw.code;
    this.class = raw.class;
    if (raw.hint) this.hint = raw.hint;
  }
}

/** 形状判据：`code` 与 `detail` 都是字符串才算。只看 `code` 会把普通对象误判进去。 */
export function isRawAppError(e: unknown): e is RawAppError {
  if (!e || typeof e !== "object") return false;
  const r = e as Record<string, unknown>;
  return typeof r.code === "string" && typeof r.detail === "string";
}

/**
 * 统一转换。**幂等**：`IpcError` 再进来原样返回，不会套两层。
 *
 * `class` 不在已知集合里时落到 `internal`——契约坏了本身就是我们的问题，
 * 归到 `environment`（用户能处理）会让这类错误被静默忽略。
 *
 * 🔴 `class` 单独校验，不写进类型守卫：守卫声明「有 code 和 detail」就够了，
 * 顺手断言 `class` 合法等于让类型系统替运行时撒谎——非法值能一路传到 UI。
 */
export function toIpcError(e: unknown): unknown {
  if (e instanceof IpcError) return e;
  if (!isRawAppError(e)) return e;
  const raw = e as unknown as Record<string, unknown>;
  const cls = CLASSES.find((c) => c === raw.class) ?? "internal";
  const hint = typeof raw.hint === "string" && raw.hint.trim() ? raw.hint : undefined;
  return new IpcError({ code: e.code, class: cls, detail: e.detail, hint });
}

/** 取结构化错误（不是就返回 null）。给 `friendlyError` 按 `code` 查表用。 */
export function appErrorOf(e: unknown): IpcError | null {
  return e instanceof IpcError ? e : null;
}
