#!/usr/bin/env node
/**
 * 命令面板清单（DESIGN.md §4）。
 *
 * 用法：
 *   node scripts/palette-inventory.mjs            # 打印清单
 *   node scripts/palette-inventory.mjs --json     # 机器可读
 *
 * 只读，不判红：命令是运行时注册的，静态代码里没有"全部动作"的权威集合，
 * 硬判覆盖率只会逼人往面板里塞假命令。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { formatReport, summarize } from "./lib/palette-inventory.mjs";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SRC = join(ROOT, "src");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full) && !/\.test\./.test(full)) out.push(full);
  }
  return out;
}

const files = walk(SRC).map((f) => ({ path: relative(ROOT, f).split(sep).join("/"), text: readFileSync(f, "utf8") }));
const summary = summarize(files);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log("命令面板清单（DESIGN.md §4）\n");
  console.log(formatReport(summary));
  console.log("\n提示：没有快捷键的命令不代表有问题——长尾动作本来就只能从面板走。");
  console.log("      但如果一个动作既不在面板、也没有快捷键，它就等于不存在。");
}
