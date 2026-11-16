/**
 * 交互延迟预算判定（纯函数，供 interaction-budget.mjs 与单测共用）。
 *
 * 预算值的唯一真源是 `desktop/DESIGN.md` §3。这里只做判定与排版，
 * 不负责采集——采集在 `src/lib/interactionBudget.ts`（dev 构建内置）。
 */

export const BUDGETS = {
  keydown: { label: "编辑输入回显", p95: 50 },
  command: { label: "命令面板/菜单打开", p95: 100 },
  "tab-switch": { label: "页面/标签切换", p95: 150 },
  drag: { label: "面板拖拽", p95: 20 },
};

/** 采集端可能给出 { summary } 或直接给 { samples }；两种都吃。 */
export function normalize(input) {
  if (!input || typeof input !== "object") return { samples: [], summary: {} };
  if (input.summary && typeof input.summary === "object") return { summary: input.summary };
  if (Array.isArray(input.samples)) return { summary: groupSamples(input.samples) };
  return { summary: {} };
}

function pct(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

export function groupSamples(samples) {
  const grouped = new Map();
  for (const s of samples) {
    if (!s || !Number.isFinite(s.ms) || s.ms < 0) continue;
    const arr = grouped.get(s.kind) ?? [];
    arr.push(s.ms);
    grouped.set(s.kind, arr);
  }
  const out = {};
  for (const [kind, values] of grouped) {
    out[kind] = {
      n: values.length,
      p50: Math.round(pct(values, 50)),
      p95: Math.round(pct(values, 95)),
      max: Math.round(Math.max(...values)),
    };
  }
  return out;
}

/**
 * @returns {{ rows: object[], failed: string[], unmeasured: string[] }}
 */
export function evaluate(summary, budgets = BUDGETS) {
  const rows = [];
  const failed = [];
  const unmeasured = [];

  for (const [kind, budget] of Object.entries(budgets)) {
    const measured = summary?.[kind];
    if (!measured || !measured.n) {
      unmeasured.push(kind);
      rows.push({ kind, label: budget.label, n: 0, p50: "-", p95: "-", budget: budget.p95, status: "未测" });
      continue;
    }
    const over = measured.p95 - budget.p95;
    const status = over > 0 ? `超 ${over}ms` : "达标";
    if (over > 0) failed.push(`${kind} p95=${measured.p95}ms > 预算 ${budget.p95}ms`);
    rows.push({
      kind,
      label: budget.label,
      n: measured.n,
      p50: measured.p50,
      p95: measured.p95,
      budget: budget.p95,
      status,
    });
  }

  // 采集到但不在预算表里的 kind 也要露出来，防止"改了名字就悄悄不判了"。
  for (const [kind, measured] of Object.entries(summary ?? {})) {
    if (budgets[kind]) continue;
    rows.push({ kind, label: "（未定义预算）", n: measured.n, p50: measured.p50, p95: measured.p95, budget: "-", status: "待补预算" });
  }

  return { rows, failed, unmeasured };
}

export function formatTable(rows) {
  const head = ["场景", "样本", "p50", "p95", "预算", "判定"];
  const body = rows.map((r) => [r.label, String(r.n), String(r.p50), String(r.p95), String(r.budget), r.status]);
  const widths = head.map((h, i) => Math.max(displayWidth(h), ...body.map((b) => displayWidth(b[i]))));
  const pad = (s, w) => s + " ".repeat(Math.max(0, w - displayWidth(s)));
  const line = (cells) => cells.map((c, i) => pad(c, widths[i])).join("  ");
  return [line(head), widths.map((w) => "-".repeat(w)).join("  "), ...body.map(line)].join("\n");
}

/** 中文按 2 列宽算，否则表格会歪。 */
function displayWidth(text) {
  let w = 0;
  for (const ch of String(text)) w += /[\u4e00-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
  return w;
}
