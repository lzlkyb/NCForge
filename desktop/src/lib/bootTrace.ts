// 启动分段打点：首帧 / 目录树 / 索引就绪 / 首批诊断。
//
// 起点在 Rust（`boot_timing.rs` 的 `main()` 第一行）：`performance.now()` 的 0 点是
// document start，不含进程创建与 WebView2 初始化，而冷启动的大头恰恰在那一段。
//
// 每一段只报一次，且失败静默——这是一条统计，不该因为后端没这个命令就变成一个用户可见的错误。
import { invoke } from "./tauri";

export type BootStage = "tree" | "index" | "diag";

const sent = new Set<string>();

/** 首帧：整个进程只调一次。rAF 回调意味着这一帧已经画出来了。 */
export function reportFirstFrame(): void {
  if (sent.has("frame")) return;
  sent.add("frame");
  const frontendMs = Math.round(performance.now());
  void invoke<number | null>("boot_report", { ms: frontendMs })
    .then((total) => console.info(`[boot] 进程启动 → 首帧 ${total ?? "?"} ms（前端自计 ${frontendMs} ms）`))
    .catch(() => {});
}

/**
 * 记一段。重复调用只有第一次生效：索引就绪、首批诊断这类事件在一个进程里
 * 会反复发生（换模块、改文件），但启动基线只认第一次。
 */
export function markBootStage(stage: BootStage): void {
  if (sent.has(stage)) return;
  sent.add(stage);
  const ms = Math.round(performance.now());
  void invoke<number | null>("boot_stage", { stage, ms })
    .then((total) => {
      if (total != null) console.info(`[boot] 进程启动 → ${stage} ${total} ms`);
    })
    .catch(() => {});
}
