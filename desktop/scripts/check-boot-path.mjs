#!/usr/bin/env node
/**
 * 启动路径门禁：`src-tauri/src/main.rs` 的 `fn main` 里禁止同步目录遍历。
 *
 * 为什么有这条（方案 §7 风险表最后一条）：启动时长是「轻量 + 速度」唯一可被用户
 * 直接感知的指标，而它最容易被无意中毁掉的方式就是「在 setup 里顺手 s 个盘」——
 * 一次 `for entry in read_dir(...)` 只写 5 行，代价是每次启动多等几百毫秒到几秒，
 * 而且在开发机上（盘热、目录小）完全看不出来。没人会为了这 5 行去 review 启动时间。
 *
 * 边界（写清楚，免得以为是万能的）：
 *   · 只看 `main.rs` 的 `fn main` 段（含 `.setup()` / `.on_window_event()` / `.run()`
 *     三个闭包）。`main.rs` 之外的模块看不见 —— 真正的业务扫描在 `lib.rs` 挂的
 *     命令里，那些都是「用户点了才跑」，不在启动路径上。
 *   · 只禁**目录遍历**。单文件读（`fs::read_to_string`）、单次 stat（`metadata`）、
 *     写目录（`create_dir_all`）都不算扫盘，放行。
 *   · 剥掉注释再匹配：注释里写 `read_dir` 是解释，不是代码。
 *
 * 用法：
 *   node scripts/check-boot-path.mjs           # 检查
 *   node scripts/check-boot-path.mjs --print   # 同时打印扫描到的行数与首条语句
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mainRs = resolve(here, "../src-tauri/src/main.rs");

/** 禁的是「遍历目录」这一类。每条带一句为什么，红的时候直接给人看。 */
const FORBIDDEN = [
  { re: /\bread_dir\b/, why: "std::fs::read_dir 会在启动路径上同步枚举目录" },
  { re: /\breaddir\b/, why: "readdir 会在启动路径上同步枚举目录" },
  { re: /\bWalkDir\b/, why: "WalkDir 递归扫盘，比 read_dir 更贵" },
  { re: /\bwalkdir\b/, why: "walkdir 递归扫盘，比 read_dir 更贵" },
  { re: /\bglob\s*(::|\()/, why: "glob 展开要先遍历目录" },
  { re: /\bfrom_dir\s*\(/, why: "从目录批量加载（插件/资源清单）会扫盘" },
];

/** `fn main` 之后的第一条语句：起点必须在 Rust 侧且在最前面，见 boot_timing 头注释。 */
const FIRST_STATEMENT = "boot_timing::mark_process_start()";

/**
 * 剥注释：先块注释后行注释。
 *
 * 不做完整的词法分析（不认字符串字面量）—— 代价是「字符串里出现 `//`」这种情况
 * 会把后半行一起剥掉，可能漏检。`main.rs` 里没有这种字面量，而为此引一个 Rust
 * 词法器不值得；漏检的方向也是「放过」而不是「误报」，不会挡住正常提交。
 */
function stripComments(text) {
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return noBlock
    .split(/\r?\n/)
    .map((line) => {
      const i = line.indexOf("//");
      return i < 0 ? line : line.slice(0, i);
    })
    .join("\n");
}

function scan() {
  const raw = readFileSync(mainRs, "utf8");
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((l) => /^fn main\s*\(/.test(l));
  if (start < 0) return { error: "在 main.rs 里找不到顶格的 `fn main(`" };
  const tail = lines.slice(start);
  // main 必须是文件里最后一个函数：否则「截到文件末尾」会把别的函数也算进启动路径。
  // 真出现了就让人改脚本，不要默默扩大扫描范围。
  const later = tail.findIndex((l, i) => i > 0 && /^fn [a-z_]/i.test(l));
  if (later > 0) {
    return {
      error: `fn main 之后还有顶格函数（第 ${start + later + 1} 行），请把本脚本改成按大括号配平取 main 段`,
    };
  }
  const body = stripComments(tail.join("\n"));
  return { start, body };
}

const result = scan();
if (result.error) {
  console.error(`❌ 启动路径门禁无法判定：${result.error}`);
  process.exit(1);
}

const problems = [];
const bodyLines = result.body.split(/\r?\n/);
bodyLines.forEach((line, i) => {
  if (!line.trim()) return;
  for (const rule of FORBIDDEN) {
    if (rule.re.test(line)) {
      problems.push({
        line: result.start + i + 1,
        text: line.trim(),
        why: rule.why,
      });
    }
  }
});

// 第一条语句：跳过签名行本身、空行、注释残留、以及 `{` 单独成行的情况。
const firstIdx = bodyLines.findIndex(
  (l, i) => i > 0 && l.trim() && l.trim() !== "{" && !/^fn main\s*\(/.test(l.trim()),
);
const first = firstIdx >= 0 ? bodyLines[firstIdx].trim() : "";
if (!first.includes(FIRST_STATEMENT)) {
  problems.push({
    line: result.start + (firstIdx < 0 ? 1 : firstIdx) + 1,
    text: first || "（空）",
    why: `main 的第一条语句必须是 ${FIRST_STATEMENT}：起点晚一行就少算一段，冷启动基线会偏小`,
  });
}

if (process.argv.includes("--print")) {
  console.log(`扫描范围：main.rs 第 ${result.start + 1} 行起，共 ${bodyLines.length} 行（已剥注释）`);
  console.log(`第一条语句：${first}`);
}

if (problems.length) {
  console.error("❌ 启动路径门禁未通过：");
  for (const p of problems) {
    console.error(`   main.rs:${p.line}  ${p.text}`);
    console.error(`      ↳ ${p.why}`);
  }
  console.error("");
  console.error("   启动路径上要扫的东西挪到后台任务里（`spawn_supervised` + `spawn_prewarm_*` 的先例），");
  console.error("   或者等用户点了再扫。真要在这里扫，先量一次启动耗时再决定。");
  process.exit(1);
}

console.log(
  `✅ 启动路径门禁通过（fn main 段 ${bodyLines.length} 行，无同步目录遍历，起点在第一行）`,
);
