import { SettingsRow } from "../ui/SettingsRow";
import type { WorkerStats } from "../../lib/compile";

/**
 * 编译进程统计行：常驻 worker 与一次一进程的计数、回退原因、耗时分布。
 *
 * 单独成文件是为了让 BuildSettings 守住 300 行体量门禁；这里的状态完全来自
 * `build_cache_info`，没有自己的副作用。
 */
export function WorkerStatsRow({
  worker,
  persistent,
}: {
  worker: WorkerStats | undefined;
  persistent: boolean;
}) {
  return (
    <SettingsRow
      id="build-worker-stats"
      label="编译进程统计"
      keywords={["编译", "常驻", "worker", "冷启动", "回退", "耗时"]}
      sub={workerLine(worker, persistent)}
      info="进程内累计，重启清零。回退 = 常驻进程不可用（缺桥 jar、启动失败、协议错误、堆不足）后改走一次一进程；超时与取消单列。耗时分布按 <100ms、<300ms、<1s、<3s、≥3s 五档统计；均值只看当前生效路径。"
      valueText={workerAvg(worker, persistent)}
    />
  );
}

/**
 * 计数行的口径：回退与超时/取消分开——回退是环境问题，超时和取消是这一轮没跑完，
 * 混在一起看会误判「常驻不稳定」。
 */
function workerLine(w: WorkerStats | undefined, persistent: boolean): string {
  if (!w) return "还没有统计数据";
  const runs = w.workerCompiles + w.oneshotCompiles;
  if (!runs) return "本次启动还没有编译记录";
  const fallbacks = w.fallbackMissing + w.fallbackSpawn + w.fallbackProtocol + w.fallbackOom;
  const parts = [`复用 ${w.warmHits}`, `冷启动 ${w.coldStarts}`, `一次一进程 ${w.oneshotCompiles}`, `回退 ${fallbacks}`];
  if (w.timeouts) parts.push(`超时 ${w.timeouts}`);
  if (w.cancels) parts.push(`取消 ${w.cancels}`);
  if (w.trimmed) parts.push(`空闲回收 ${w.trimmed}`);
  const latency = latencyLine(w.latency);
  if (latency) parts.push(latency);
  const avg = workerAvg(w, persistent);
  if (avg !== "—") parts.push(avg);
  return parts.join(" · ");
}

/** 耗时分布只列非零桶：五档全 0 时不要占一行。 */
function latencyLine(latency: number[] | undefined): string {
  if (!latency?.length) return "";
  const labels = ["<100ms", "<300ms", "<1s", "<3s", "≥3s"];
  const parts = latency
    .map((n, i) => (n ? `${labels[i] ?? `#${i}`} ${n}` : ""))
    .filter(Boolean);
  return parts.length ? `耗时 ${parts.join(" · ")}` : "";
}

/** 均值只显示当前生效路径：常驻关了看一次一进程，开了看 worker。 */
function workerAvg(w: WorkerStats | undefined, persistent: boolean): string {
  if (!w) return "—";
  const done = persistent ? w.workerCompiles : w.oneshotCompiles;
  if (!done) return "—";
  const total = persistent ? w.workerMsTotal : w.oneshotMsTotal;
  const ms = Math.round(total / done);
  return ms >= 1000 ? `均 ${(ms / 1000).toFixed(1)} s` : `均 ${ms} ms`;
}
