// 调试的键位与「调试模式」偏好。
//
// 两套键位与设置页的 keymap 同源（`lib/keymap`）：Eclipse 是 F5–F8，IDEA 是 F7/F8/Shift+F8/F9。
// 同一枚 F 键在两套方案里含义不同（F7：Eclipse 步出 / IDEA 步入），所以不能写成
// 「按 F7 就步入」——必须在按键那一刻查当前方案。F11 已被书签占用，这里不碰。
import { getKeymap } from "./keymap";
import { resumeDebug, stepDebug } from "./debugSession";

export type DebugKeyAction = "resume" | "over" | "into" | "out";
export type DebugKeyCode = "F5" | "F6" | "F7" | "F8" | "F9";

export function debugActionForKey(code: DebugKeyCode, shift: boolean): DebugKeyAction | null {
  if (getKeymap() === "idea") {
    if (code === "F7") return "into";
    if (code === "F8") return shift ? "out" : "over";
    if (code === "F9") return "resume";
    return null;
  }
  if (shift) return null;
  if (code === "F5") return "into";
  if (code === "F6") return "over";
  if (code === "F7") return "out";
  if (code === "F8") return "resume";
  return null;
}

/** 面板按钮上的键位提示（与 `debugActionForKey` 同一张表）。 */
export function debugKeyLabels(): Record<DebugKeyAction, string> {
  return getKeymap() === "idea"
    ? { resume: "F9", over: "F8", into: "F7", out: "Shift+F8" }
    : { resume: "F8", over: "F6", into: "F5", out: "F7" };
}

/** 执行一步。未附加 / 未暂停时下层动作自己会空转，这里不重复判断。 */
export function runDebugAction(action: DebugKeyAction): void {
  if (action === "resume") void resumeDebug();
  else void stepDebug(action);
}

const DEBUG_MODE_KEY = "ncforge-debug-mode";

/** 下次启动是否带 JDWP（服务页的「调试模式」开关）。 */
export function readDebugModePref(): boolean {
  try {
    return localStorage.getItem(DEBUG_MODE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeDebugModePref(on: boolean): void {
  try {
    localStorage.setItem(DEBUG_MODE_KEY, on ? "1" : "0");
  } catch {
    // 隐私模式：本次会话内仍按内存里的开关走
  }
}

const CLIENT_DEBUG_MODE_KEY = "ncforge-client-debug-mode";

/**
 * 客户端是否带 JDWP 启动。
 *
 * 与服务端分开存：两者是独立 JVM，同时开调试会各占一个回环端口；共用开关会让
 * 「只想调客户端」的人把服务也拖进调试模式（反之亦然）。
 */
export function readClientDebugModePref(): boolean {
  try {
    return localStorage.getItem(CLIENT_DEBUG_MODE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeClientDebugModePref(on: boolean): void {
  try {
    localStorage.setItem(CLIENT_DEBUG_MODE_KEY, on ? "1" : "0");
  } catch {
    // 隐私模式：本次会话内仍按内存里的开关走
  }
}
