import { useSyncExternalStore } from "react";
import { prefersReducedMotion, subscribeMotionPreference } from "../lib/motionPreference";

/**
 * 监听系统「减弱动效」偏好（prefers-reduced-motion）。
 * 返回 true 时，所有动效应降级为即时（无位移/无时长），保证可访问性。
 * 初始值同步读取一次，避免首帧闪动；之后随系统设置变化实时更新。
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeMotionPreference, prefersReducedMotion, () => false);
}
