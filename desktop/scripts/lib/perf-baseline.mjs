/**
 * 性能基线的取数与判定 —— 纯函数，方便测。
 *
 * 为什么要单独立一层（A0，方案 §4.2）：五个速度指标散在三个探针里
 * （Rust 的 `单文件编译_p50`、`code-editor-gaps-live.mjs`、`lang-index-bench.mjs`），
 * 外加一条只能从真机日志里读的冷启动。每次想知道「现在到底多快」都要人肉翻
 * 三份 JSON 加一份日志，再对着方案里的目标心算——这种活儿必然算错，也必然
 * 有人把「没测」写成「达标」。
 *
 * 这里的契约只有一条：**没数就是没数**。任何一路探针缺席、跳过、失败，
 * 对应行一律 `未测` 并带上原因，绝不填 0、不填上一轮的旧值、不按目标反推。
 * 目标值抄自方案 §4.2，改目标要同时改那边，否则表和方案会对不上账。
 */

/**
 * 五指标 + 两条代价基线。
 *
 * `source` 决定这一行从哪儿取数：
 *   ecj    → Rust `#[ignore]` 测试 `单文件编译_p50` 的 `PERF ` 输出行
 *   gaps   → `target/test-tmp/editor-gaps.json`
 *   index  → `target/test-tmp/lang-index-bench.json`
 *   boot   → 真机运行日志里的「冷启动：进程启动 → 前端首帧 N ms」
 *   none   → 还没有探针，只能标未测（写出来是为了让缺口可见，而不是假装只有五项）
 *
 * `target: null` = 这一项只作代价基线，方案没给目标值，不参与达标判定。
 */
export const CHANNELS = [
  { id: "boot", name: "冷启动 → 首帧可编辑", target: 2000, source: "boot" },
  { id: "index", name: "jdt.ls 全量索引（fixture）", target: 60000, source: "index" },
  { id: "compile", name: "单文件保存 → 出 class（p50）", target: 400, source: "ecj" },
  { id: "completion", name: "补全 p50（普通文件·热）", target: 150, source: "gaps" },
  { id: "bigfile", name: "大文件 didOpen → 首批诊断", target: null, source: "gaps" },
  { id: "bigfile-completion", name: "大文件补全 p50", target: null, source: "gaps" },
  { id: "incremental", name: "1–5 文件增量编译", target: 1500, source: "none" },
];

/** 判定口径：方案写的是「< 0.4 s」，所以是严格小于，等于目标算超标。 */
export function verdictOf(value, target) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "未测";
  if (target === null || target === undefined) return "基线";
  return value < target ? "达标" : "超标";
}

/**
 * 解析 Rust 侧的 `PERF single-file-compile n=… min=… p50=… max=… mean=…`。
 *
 * 三种非正常结局要分开报，别混成一个「未测」：
 *   · `跳过：…`  —— 本机缺 java/ecj/桥 jar，是环境问题；
 *   · `PERF … failed: …` —— 编译没过。失败耗时不是基线，拿它当数会显得「提速了」；
 *   · 什么都没有 —— 测试没跑起来（cargo 编译失败等）。
 */
export function parseEcjPerf(text) {
  const src = String(text ?? "");
  const hit = /PERF single-file-compile n=(\d+) min=(\d+) p50=(\d+) max=(\d+) mean=(\d+)/.exec(src);
  if (hit) {
    const [, n, min, p50, max, mean] = hit.map(Number);
    return { ok: true, n, min, p50, max, mean };
  }
  const failed = /PERF single-file-compile failed: (.+)/.exec(src);
  if (failed) return { ok: false, reason: `编译失败：${failed[1].trim().slice(0, 120)}` };
  const skipped = /跳过：(.+)/.exec(src);
  if (skipped) return { ok: false, reason: skipped[1].trim().slice(0, 120) };
  return { ok: false, reason: "没拿到 PERF 行（测试没跑起来？）" };
}

/**
 * 从真机日志里读冷启动。`boot_timing.rs` 写的是 log::info!，
 * env_logger 默认打到 stderr —— 没有日志文件，所以要用户自己重定向一份进来。
 *
 * 同一份日志里可能有多次启动（重启过应用）。取**最后一次**：那才是当前这份
 * 代码的表现，前面几次多半是改代码之前的。
 */
export function parseBootLog(text) {
  const src = String(text ?? "");
  const frames = [...src.matchAll(/冷启动：进程启动 → 前端首帧 (\d+) ms/g)];
  if (frames.length === 0) return null;
  const firstFrameMs = Number(frames.at(-1)[1]);
  const stages = {};
  for (const m of src.matchAll(/启动分段：进程启动 → (tree|index|diag) (\d+) ms/g)) {
    stages[m[1]] = Number(m[2]);
  }
  return { firstFrameMs, stages, runs: frames.length };
}

/** 安全取数：JSON 缺字段时给 null，不给 undefined —— 表里要能一眼看出「没测」。 */
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * 把一轮索引拆成「OSGi 引导」与「状态推进」两段。
 *
 * 🔴 为什么必须拆（2026-11-15 实测，别再把它当缓存收益）：
 * 2000 文件三轮 fresh 17792 / warm 12963 / old 17445 ms，看着像「缓存省了 4.8 s」。
 * 但按 `language/status` 的时间戳拆开：
 *   fresh 引导 13437 + 状态 4355 · warm 引导 8679 + 状态 4284 · old 引导 12804 + 状态 4641
 * **状态段三轮几乎一样（4.3~4.6 s），差异全在引导段**——那是 OSGi 解析 bundle、
 * 建 config  area 的开销，第一次跑要解压/校验，后面两次沾的是**文件系统缓存与
 * OSGi 产物已存在**的光，跟「索引缓存复用」不是一回事。
 *
 * 判据：`handshakeMs`（initialize 返回）几乎等于首条状态之前的全部耗时，
 * 所以 `totalMs - 状态跨度` 就是引导段。拿总耗时的差当索引收益 = 把 JVM 启动
 * 的抖动记到索引账上，会得出「缓存有效」的反向结论。
 */
export function splitIndexRound(round) {
  const total = num(round?.totalMs);
  const statuses = Array.isArray(round?.statuses) ? round.statuses : [];
  if (total === null || statuses.length < 2) return { total, boot: null, progress: null };
  const span = statuses.at(-1).at - statuses[0].at;
  if (!Number.isFinite(span) || span < 0 || span > total) return { total, boot: null, progress: null };
  return { total, boot: total - span, progress: span };
}

/**
 * 把四路输入拼成一张表。任何一路缺席都不影响其余行。
 *
 * @param {{ecj?: object|null, gaps?: object|null, index?: object|null, boot?: object|null}} inputs
 */
export function buildRows(inputs = {}) {
  const { ecj = null, gaps = null, index = null, boot = null } = inputs;
  const latency = gaps?.diagnosticsLatency ?? {};
  const valueOf = {
    boot: () => num(boot?.firstFrameMs),
    index: () => num(index?.verdict?.firstImportMs),
    compile: () => (ecj?.ok ? num(ecj.p50) : null),
    completion: () => num(gaps?.completion?.p50Ms),
    bigfile: () => num(latency.bigFileMs),
    "bigfile-completion": () => num(latency.bigFileCompletionP50Ms),
    incremental: () => null,
  };
  const noteOf = {
    boot: () => (boot ? `日志里 ${boot.runs} 次启动，取最后一次` : "需真机跑一次，把 stderr 存成文件后 --boot-log=<路径>"),
    index: () => {
      if (!index) return "跑 npm run test:lang-index";
      const fresh = splitIndexRound((index.rounds ?? []).find((r) => r.label === "fresh"));
      // 只报拆分后的两段，不报「缓存节省 X ms」：那个差值主要来自 OSGi 引导，不是索引。
      const seg = fresh.boot === null ? "" : `（引导 ${fresh.boot} + 索引 ${fresh.progress}）`;
      return `${index.fileCount ?? "?"} 个 java${seg}；冷热差异在引导段，别当缓存收益`;
    },
    compile: () => (ecj?.ok ? `n=${ecj.n}，${ecj.min}~${ecj.max} ms` : (ecj?.reason ?? "跑 --only=compile")),
    completion: () => (gaps ? `冷 ${num(gaps.completion?.coldMs) ?? "?"} ms，n=${gaps.completion?.samples ?? 0}` : "跑 npm run test:editor-gaps"),
    bigfile: () => (gaps ? `${latency.bigFileLines ?? "?"} 行` : "跑 npm run test:editor-gaps"),
    "bigfile-completion": () => (gaps ? "降级只关 quickSuggestions，`.` 与 Ctrl+Space 仍在" : "跑 npm run test:editor-gaps"),
    incremental: () => "未接探针：ecj 只覆盖单文件，改 3 个文件的流程还没打点",
  };
  return CHANNELS.map((c) => {
    const value = valueOf[c.id]();
    return {
      id: c.id,
      name: c.name,
      value,
      target: c.target,
      verdict: verdictOf(value, c.target),
      source: c.source,
      note: noteOf[c.id](),
    };
  });
}

/** 人读的一张表。用等宽补齐而不是 console.table：要能原样贴进 docs。 */
export function formatTable(rows) {
  const cells = rows.map((r) => ({
    指标: r.name,
    实测: r.value === null ? "未测" : `${r.value} ms`,
    目标: r.target === null ? "—" : `< ${r.target} ms`,
    判定: r.verdict,
    备注: r.note,
  }));
  const cols = Object.keys(cells[0] ?? { 指标: "", 实测: "", 目标: "", 判定: "", 备注: "" });
  // 中文按 2 个字符宽算，否则备注一长整张表就歪了。
  const width = (s) => [...String(s)].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  const pad = (s, w) => String(s) + " ".repeat(Math.max(0, w - width(s)));
  const sizes = cols.map((c) => Math.max(width(c), ...cells.map((row) => width(row[c]))));
  const line = (row) => `| ${cols.map((c, i) => pad(row[c], sizes[i])).join(" | ")} |`;
  const rule = `|-${sizes.map((w) => "-".repeat(w)).join("-|-")}-|`;
  return [line(Object.fromEntries(cols.map((c) => [c, c]))), rule, ...cells.map(line)].join("\n");
}

/** 一句话结论：几项达标、几项超标、几项没测。没测单独说，别混进「达标率」。 */
export function summarize(rows) {
  const count = (v) => rows.filter((r) => r.verdict === v).length;
  const judged = count("达标") + count("超标");
  return {
    pass: count("达标"),
    over: count("超标"),
    untested: count("未测"),
    baseline: count("基线"),
    text: judged === 0
      ? `没有可判定的指标（${count("未测")} 项未测）——先把探针跑起来`
      : `${count("达标")}/${judged} 项达标，${count("超标")} 项超标，${count("未测")} 项未测，${count("基线")} 项只作基线`,
  };
}