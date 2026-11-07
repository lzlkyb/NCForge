#!/usr/bin/env node
/**
 * Rust 测试临时目录棘轮：`#[cfg(test)]` 之后的 `std::env::temp_dir()` 只许减不许增。
 *
 * 为什么有这条门禁（2026-11-06 的 CI 失败）：97 处临时目录几乎全是「每个文件各写
 * 一份」的 `std::env::temp_dir().join(format!("x-{}", id))`。裸 temp_dir 在三个
 * 平台上给出三种字符串：
 *   · macOS：`/var/folders/...`，而 `/var` 是 `/private/var` 的符号链接；
 *   · Windows CI：`C:\Users\RUNNER~1`（8.3 短名）；
 *   · 本地 Windows：正常长名。
 * 产品代码里凡是 canonicalize 过的路径都与它们对不上，于是断言只在该平台红 ——
 * 本地全绿，CI 一推就炸。
 *
 * 正确做法：`crate::test_support::tmp("tag")`（src/test_support.rs），它返回
 * 规范化后的路径。存量 97 处不强行迁移（逐个改 40 个文件的回归风险大于收益），
 * 但**新代码不许再加裸调用**：这条棘轮就是那个闸。
 *
 * 用法：
 *   node scripts/check-rust-tempdir.mjs            # 检查（超基线即失败）
 *   node scripts/check-rust-tempdir.mjs --update   # 按实测值下调/更新基线
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcTauri = resolve(here, "../src-tauri");
const baselinePath = join(here, "rust-tempdir-baseline.json");

const CALL = /env::temp_dir\s*\(/g;
/** `#[cfg(test)]` 与 `#[cfg(all(test, unix))]` 都算。 */
const CFG_TEST = /#\[cfg\(\s*(all\()?test[\s,)]/;

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

/**
 * 数一个文件里的裸调用。
 * `onlyAfterCfgTest` 为真时只看第一个 `#[cfg(test)]` 之后的行 —— 生产代码里用
 * temp_dir 是正当的（导出临时文件等），不该被这条规则管。
 */
function countInFile(file, onlyAfterCfgTest) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  let from = 0;
  if (onlyAfterCfgTest) {
    from = lines.findIndex((l) => CFG_TEST.test(l));
    if (from < 0) return 0;
  }
  let n = 0;
  for (const line of lines.slice(from)) n += (line.match(CALL) ?? []).length;
  return n;
}

function measure() {
  const unitFiles = walk(join(srcTauri, "src"));
  const integFiles = walk(join(srcTauri, "tests"));
  let unit = 0;
  let integration = 0;
  const offenders = [];
  for (const f of unitFiles) {
    const n = countInFile(f, true);
    if (n > 0) {
      unit += n;
      offenders.push({ file: relative(srcTauri, f), n });
    }
  }
  for (const f of integFiles) integration += countInFile(f, false);
  offenders.sort((a, b) => b.n - a.n || a.file.localeCompare(b.file));
  return { unit, integration, offenders };
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

if (update || !base) {
  const next = {
    _note:
      "Rust 测试里裸用 std::env::temp_dir() 的处数（#[cfg(test)] 之后 / tests 目录）。只许减不许增：" +
      "新测试请用 crate::test_support::tmp(\"tag\")，它返回规范化路径，能消掉 macOS /var 与 Windows 8.3 短名的平台差异。",
    unit: now.unit,
    integration: now.integration,
  };
  writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  console.log(
    `✅ 已写入基线：模块内 ${now.unit} 处 / integration ${now.integration} 处 → ${relative(process.cwd(), baselinePath)}`,
  );
  process.exit(0);
}

const problems = [];
if (now.unit > base.unit) {
  problems.push(`模块内 ${now.unit} 处 > 基线 ${base.unit}（多了 ${now.unit - base.unit} 处）`);
}
if (now.integration > base.integration) {
  problems.push(`integration ${now.integration} 处 > 基线 ${base.integration}（多了 ${now.integration - base.integration} 处）`);
}

if (problems.length) {
  console.error("❌ Rust 测试临时目录棘轮未通过：");
  for (const p of problems) console.error(`   ${p}`);
  console.error("");
  console.error("   新测试请改用 crate::test_support::tmp(\"tag\")（src/test_support.rs）：");
  console.error("   它返回 canonicalize 过的路径 —— macOS 的 /var → /private/var、");
  console.error("   Windows CI 的 RUNNER~1 短名，都会让裸 temp_dir 拼出的路径与产品代码对不上，");
  console.error("   表现为「本地全绿、CI 红」。");
  console.error("");
  console.error("   最近的大户（先从这里看是不是自己加的）：");
  for (const o of now.offenders.slice(0, 8)) console.error(`     ${String(o.n).padStart(3)} 处  ${o.file}`);
  console.error("");
  console.error("   确有必要（例如测试的就是 temp_dir 本身）：node scripts/check-rust-tempdir.mjs --update");
  process.exit(1);
}

const saved =
  now.unit < base.unit || now.integration < base.integration
    ? `；低于基线，可跑 --update 下调`
    : "";
console.log(
  `✅ Rust 测试临时目录棘轮通过（模块内 ${now.unit} 处 / integration ${now.integration} 处，均未超过基线${saved}）`,
);
