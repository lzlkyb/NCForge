#!/usr/bin/env node
/**
 * Rust 源文件体量门禁（`.rs` 版的体量红线）。
 *
 * 为什么要有这一条（2026-11-12）：前端 `.tsx` 有 300 行红线，Rust 侧**一条都没有**。
 * 实测当时 `src/` 下 268 个 `.rs`、生产代码约 10.6 万行，其中 105 个文件超 300 行、
 * 44 个超 600 行，最大 `db_rust.rs` 生产段 2,939 行（`impl Session` 一个块 1,540 行
 * / 37 个方法）。没有约束时唯一的"约束"是写的人当时的自觉。
 *
 * 两条规则，分工不同：
 *
 *   1. **新文件 ≤ 600 行**（MAX_LINES）。硬红线，无基线、无例外。
 *      新建一个 700 行的文件就是该拆的信号，成本只是多建一个 `mod`。
 *
 *   2. **超标文件个数只许减**（基线里的 `maxOverLimitFiles`）。
 *
 * 🔴 为什么第 2 条数"个数"而不是逐个文件记行数 —— 这是本脚本唯一一个反直觉的决定，
 * 别改回去：把 44 个存量文件按当前行数逐一登记、只许变小，看着更严格，实际会在
 * 第一次给 `db_rust.rs` 加 3 行修复时就红。正常业务改动天天落在这些大文件里，
 * 于是每次提交都得跑 `--update`，棘轮立刻退化成"顺手敲的一条命令"，只剩噪音。
 * 数个数则与正常编辑无关：往 2,939 行的文件里加代码**不改变个数**，只有"又长出
 * 一个超 600 行的文件"才会红 —— 那正是要拦的事。
 * 同构的先例：`check-rust-tempdir.mjs` 也是数总处数（97 处）而不是记每处位置，
 * 理由相同（`--update` 下调时不需要维护路径）。
 *
 * 为什么不数测试行：行数按**第一个顶层 `#[cfg(test)]` 之前**算生产段。否则
 * "多写测试"会被这条规则惩罚，方向就反了。测试本身可以长（`tests/` 目录不扫）。
 *
 * 用法：
 *   node scripts/check-source-size.mjs            # 检查（新文件超限或个数上涨即失败）
 *   node scripts/check-source-size.mjs --update   # 按实测下调/重写基线（会把上调打出来）
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcTauri = resolve(here, "../src-tauri");
const baselinePath = join(here, "source-size-baseline.json");

/** 新文件上限。存量超标文件不受它约束（它们靠第 2 条规则只许变少）。 */
const MAX_LINES = 600;

/**
 * 顶层 `#[cfg(test)]` / `#[cfg(all(test, unix))]`。允许行首缩进：
 * `mod xxx` 里的测试模块是缩进写的，那段同样是测试而不是生产逻辑。
 * 只看**第一个**匹配行 —— 约定是测试模块放文件末尾，中间插测试的情况没有。
 */
const CFG_TEST = /^\s*#\[cfg\(\s*(all\()?test[\s,)]/;

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "target" || e.name === "node_modules") continue;
      walk(p, out);
    } else if (e.name.endsWith(".rs")) {
      out.push(p);
    }
  }
  return out;
}

/** 生产段行数（第一个 `#[cfg(test)]` 之前）。与 `wc -l` 同一套数法。 */
function prodLines(text) {
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  const at = lines.findIndex((l) => CFG_TEST.test(l));
  return at < 0 ? lines.length : at;
}

function measure() {
  const files = new Map();
  for (const f of walk(join(srcTauri, "src"))) {
    files.set(relative(srcTauri, f).split("\\").join("/"), prodLines(readFileSync(f, "utf8")));
  }
  const over = [...files.entries()]
    .filter(([, n]) => n > MAX_LINES)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = [...files.values()].reduce((a, b) => a + b, 0);
  return { files, over, total };
}

function loadBaseline() {
  try {
    return JSON.parse(readFileSync(baselinePath, "utf8"));
  } catch {
    return null;
  }
}

const update = process.argv.includes("--update");
const now = measure();
const base = loadBaseline();

function writeBaseline(reason) {
  const prev = base?.files ?? {};
  const first = Object.keys(prev).length === 0;
  const raised = [];
  for (const [file, n] of now.over) {
    if (!(file in prev)) raised.push(`新增 ${file}（${n} 行）`);
    else if (n > prev[file]) raised.push(`涨了 ${file}（${prev[file]} → ${n} 行）`);
  }
  const dropped = Object.keys(prev).filter((f) => !now.files.has(f) || now.files.get(f) <= MAX_LINES);
  const next = {
    _note:
      `Rust 源文件体量基线。规则：新 .rs 文件 ≤ ${MAX_LINES} 行；超限文件个数只许减（与 check-rust-tempdir 同构）。` +
      "行数按第一个顶层 #[cfg(test)] 之前的生产段计——多写测试不会被罚。" +
      "files 只用于指出「这次新超标的是哪个」；真正的硬约束是 maxOverLimitFiles。",
    maxOverLimitFiles: now.over.length,
    files: Object.fromEntries(now.over),
  };
  writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  console.log(
    `✅ 已${reason}基线：超限文件 ${now.over.length} 个（>${MAX_LINES} 行）→ ${relative(process.cwd(), baselinePath)}`,
  );
  // 上调必须留痕：棘轮松动是显式动作，别让它静默发生。
  // 首次初始化时全是"新增"，报 43 条只会盖住真正的信息，跳过。
  if (raised.length && !first) {
    console.log("⚠️  以下文件比上次更大（如果只是正常业务改动，可以接受；能拆就拆）：");
    for (const r of raised.slice(0, 10)) console.log(`     ${r}`);
    if (raised.length > 10) console.log(`     …还有 ${raised.length - 10} 个`);
  }
  if (dropped.length) console.log(`ℹ️  已移出基线 ${dropped.length} 个（已拆小或不存在）：${dropped.slice(0, 5).join(", ")}`);
}

if (update || !base) {
  writeBaseline(update ? "写入" : "初始化");
  process.exit(0);
}

const problems = [];
const cap = base.maxOverLimitFiles ?? 0;
if (now.over.length > cap) {
  problems.push(`超 ${MAX_LINES} 行的文件 ${now.over.length} 个 > 基线 ${cap} 个（多了 ${now.over.length - cap} 个）`);
}

// 只用于把「新超标的是哪个」说出来。用路径做提示、用个数做判定：
// 文件改名不会误报（判定看个数），但如果刚好改名又超标，提示里会重名一次，无害。
const known = new Set(Object.keys(base.files ?? {}));
const fresh = now.over.filter(([f]) => !known.has(f));

if (problems.length) {
  console.error("❌ Rust 体量门禁未通过（新 .rs 文件 ≤600 行，超限文件个数只许减）：");
  for (const p of problems) console.error(`   ${p}`);
  if (fresh.length) {
    console.error("\n   本次新超标的文件（优先拆它，或者把新逻辑分到同目录的新文件里）：");
    for (const [f, n] of fresh.slice(0, 10)) console.error(`     ${String(n).padStart(5)} 行  ${f}`);
  }
  console.error("\n   现状最大的一批（存量，靠逐个拆小来降个数）：");
  for (const [f, n] of now.over.slice(0, 8)) console.error(`     ${String(n).padStart(5)} 行  ${f}`);
  console.error("");
  console.error("   拆法：纯计算 → 同目录新文件；状态编排 → 子模块（Rust 允许 `impl` 写在子模块里，");
  console.error("   父模块的私有字段对子模块可见）；测试不用搬，它本来就不计入行数。");
  console.error("   确有必要上调基线：node scripts/check-source-size.mjs --update（提交里会看到 JSON 变化）");
  process.exit(1);
}

const slack =
  now.over.length < cap ? `，比基线少 ${cap - now.over.length} 个，可跑 --update 下调` : "";
console.log(
  `✅ Rust 体量门禁通过（新文件 ≤${MAX_LINES} 行；超限文件 ${now.over.length} 个 / 基线 ${cap} 个${slack}；` +
    `src-tauri/src 生产段合计 ${now.total} 行）`,
);
