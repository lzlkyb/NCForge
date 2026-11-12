/**
 * 发版后的「门禁绿没绿」核对 —— 纯数据，方便测。
 *
 * 为什么需要它：tag 推的 CI 里 frontend job 会跑但**不阻断**出包（见 build.yml
 * frontend 的注释），所以「Release 出全产物」≠「门禁都绿了」。v0.5.0 就是产物
 * 齐全、run 标红，谁也没注意，直到手动补 mac 才发现 309 行的 ResultTable。
 * release.mjs 在镜像之前调这里，把两个结论分开报，红了至少有人看见。
 *
 * job 名是 build.yml 里 `name:` 的字面值 —— 那边改名，这里要跟着改，否则会对
 * 「没找到任何门禁 job」。宁可在测试里钉住这几个字符串，也别放宽成模糊匹配：
 * 模糊匹配到 Build 作业会把「产物出全」误报成「门禁绿」。
 */

/** 门禁类 job：跑的是 gate.mjs 的清单项。 */
export const GATE_JOB_NAMES = [
  "Frontend (tsc + vitest + build)",
  "Rust test suite (Windows)",
  "Rust check + test (macOS)",
];

/** 产物类 job：跑的是打包，成功也不代表门禁绿。 */
export const BUILD_JOB_NAMES = ["Build Windows exe + installer", "Build macOS app (arm64)"];

/** GitHub 的「跑完了但没成功」。skipped / neutral 不算红——tag 触发本来就会跳几个。 */
const FAILED = new Set(["failure", "cancelled", "timed_out", "startup_failure", "action_required", "stale"]);
const PENDING = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);

const conclusionOf = (job) => job.conclusion || job.status || "unknown";

/**
 * @param {{ name: string, conclusion?: string, status?: string }[]} jobs
 * @returns {{
 *   gates: {name: string, conclusion: string}[],
 *   builds: {name: string, conclusion: string}[],
 *   gateRed: {name: string, conclusion: string}[],
 *   gateSkipped: {name: string, conclusion: string}[],
 *   gateGreen: boolean,
 *   buildOk: boolean,
 *   verdict: "ok" | "gate-red" | "build-missing" | "both-bad" | "no-gate-data" | "pending"
 * }}
 */
export function summarizeRunJobs(jobs) {
  const pick = (names) =>
    (jobs || [])
      .filter((j) => j && names.includes(j.name))
      .map((j) => ({ name: j.name, conclusion: conclusionOf(j) }));

  const gates = pick(GATE_JOB_NAMES);
  const builds = pick(BUILD_JOB_NAMES);

  const gateRed = gates.filter((g) => FAILED.has(g.conclusion));
  const gateSkipped = gates.filter((g) => g.conclusion === "skipped");
  const gateGreen = gates.some((g) => g.conclusion === "success") &&
    gates.every((g) => ["success", "skipped", "neutral"].includes(g.conclusion));
  // Windows is always required. The macOS job can be present with a skipped conclusion.
  const requiredBuilds = builds.filter((b) => b.name === BUILD_JOB_NAMES[0] || b.conclusion !== "skipped");
  const hasWindows = requiredBuilds.some((b) => b.name === BUILD_JOB_NAMES[0]);
  const buildOk = hasWindows && requiredBuilds.every((b) => b.conclusion === "success");
  const buildFailed = requiredBuilds.some((b) => FAILED.has(b.conclusion) || b.conclusion === "skipped");
  const pending = [...gates, ...requiredBuilds].some((job) => PENDING.has(job.conclusion));

  let verdict = "both-bad";
  if (buildFailed) verdict = gateGreen ? "build-missing" : "both-bad";
  else if (pending) verdict = "pending";
  else if (!gates.length) verdict = "no-gate-data";
  else if (gateGreen && buildOk) verdict = "ok";
  else if (!gateGreen && buildOk) verdict = "gate-red";
  else if (gateGreen && !buildOk) verdict = "build-missing";

  return { gates, builds, gateRed, gateSkipped, gateGreen, buildOk, verdict };
}

/** 一行 job 结论，给调用方加颜色用。 */
export function formatJobLine(job) {
  return `${job.name} — ${job.conclusion}`;
}

/**
 * 结论文案（不带颜色码，颜色由调用方加）。返回 { level, title, hints }：
 *   level ok    —— 门禁全绿、产物齐全
 *   level warn  —— 产物出了但门禁红（按口径不阻断）
 *   level error —— 产物没出全（这个是真问题，镜像前该看一眼）
 */
export function describeVerdict(result) {
  const red = result.gateRed.map(formatJobLine);
  const skipped = result.gateSkipped.map((g) => g.name).join("、");

  if (result.verdict === "ok") {
    return {
      level: "ok",
      title: "门禁绿 + 产物齐",
      hints: skipped ? [`本轮未跑：${skipped}（tag 触发的正常现象）`] : [],
    };
  }
  if (result.verdict === "gate-red") {
    return {
      level: "warn",
      title: `产物已出，但门禁红：${red.join("；")}`,
      hints: [
        "按口径不阻断发版（CI 抖动挡发版比补一个补丁版更贵）。",
        "修完直接发下个补丁版带上：npm run release -- --patch",
      ],
    };
  }
  if (result.verdict === "pending") {
    return {
      level: "warn",
      title: "CI 仍在运行，门禁或构建结论待确认",
      hints: red.length ? [`已失败：${red.join("；")}`] : [],
    };
  }
  if (result.verdict === "no-gate-data") {
    return {
      level: "warn",
      title: "拿不到门禁结论（run 里没有任何门禁 job）",
      hints: [
        "要么 run 还没跑完，要么 build.yml 的 job 名改了而这里没跟着改。",
        "手动核一眼：gh run view <id> --json jobs",
      ],
    };
  }
  if (result.verdict === "build-missing") {
    return {
      level: "error",
      title: "门禁绿，但产物 job 没成功",
      hints: ["先看 run：gh run view <id> --json jobs；产物没出全之前先别镜像。"],
    };
  }
  return {
    level: "error",
    title: `门禁红且产物没出全（${red.join("；") || "门禁无结论"}）`,
    hints: ["查 run 再决定是否 --mirror-only 补镜像。"],
  };
}
