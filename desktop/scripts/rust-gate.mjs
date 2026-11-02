#!/usr/bin/env node
/**
 * Rust 门禁包装器：把 cargo 跑测试时的临时目录钉在 target/test-tmp，并显式限并发。
 *
 * 为什么需要它（2026-11-02 实测）：
 *   1. 测试里的 `std::env::temp_dir()` 落在 `C:\Users\<user>\AppData\Local\Temp`。
 *      这些目录没人删（panic/abort 时 `TempDir` 不清理，手写 join 的更不会），
 *      实测累积到 1981 个目录 / 5.12 GB，C 盘被顶到 81%。`local_history` 那条
 *      「比预算还大的文件不归档」用例更狠：一次 512MB，跑三次门禁 1.5GB。
 *   2. 裸 `cargo test` 在 16 核机器上开 16 路 rustc + 并发 link.exe，15.8GB 内存
 *      直接到 99%（历史上有 TDR / 蓝屏，见 CLAUDE.md §8.3）。
 *
 * 用法（在 desktop/ 下）：
 *   node scripts/rust-gate.mjs                        # = cargo test，跑完清临时目录
 *   node scripts/rust-gate.mjs test --no-default-features
 *   node scripts/rust-gate.mjs clippy --all-targets -- -D warnings   # 也顺手清临时目录
 *
 * 位置解析一律以本文件为基准，所以在仓库根或 src-tauri 里调用都行。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcTauri = resolve(here, "..", "src-tauri");
const tmpRoot = join(srcTauri, "target", "test-tmp");
// 系统盘的真实临时目录：留一份「没被改写」的引用，跑完拿它查漏网的。
const systemTmp = tmpdir();
// 本工具在临时目录里用的前缀（CLAUDE.md §8.3.4）。
const OWN_PREFIX = /^(ncf-|nc-forge|ncforge-)/i;
// target/debug 的健康上限。涨破就说明有人把 debuginfo 或中间产物又放回来了。
const TARGET_BUDGET = 6 * 1024 ** 3;

/** 清空临时根（只删里面的条目，根目录本身留着）。失败不致命：多半是别的进程正占着。 */
function wipeTmp() {
  if (!existsSync(tmpRoot)) return { removed: 0, bytes: 0 };
  let removed = 0;
  let bytes = 0;
  for (const name of readdirSync(tmpRoot)) {
    const p = join(tmpRoot, name);
    try {
      bytes += sizeOf(p);
      rmSync(p, { recursive: true, force: true, maxRetries: 3 });
      removed += 1;
    } catch {
      // 占用中 / 权限不足：留着，下一轮再清。绝不让清理失败挡住门禁本身。
    }
  }
  return { removed, bytes };
}

function sizeOf(p) {
  const st = statSync(p, { throwIfNoEntry: false });
  if (!st) return 0;
  if (!st.isDirectory()) return st.size;
  let sum = 0;
  for (const name of readdirSync(p)) sum += sizeOf(join(p, name));
  return sum;
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

const argv = process.argv.slice(2);
const sub = argv[0] && !argv[0].startsWith("-") ? argv[0] : "test";
const rest = argv[0] && !argv[0].startsWith("-") ? argv.slice(1) : argv;

mkdirSync(tmpRoot, { recursive: true });
const before = wipeTmp();
if (before.removed > 0) {
  console.log(`[gate] 清掉上一轮遗留的 ${before.removed} 个临时目录（${mb(before.bytes)}）`);
}

const args = [sub, ...rest];
// 只给 test 补 --test-threads：别的子命令不认这个参数。用户自己传了 `--` 就不插手。
if (sub === "test" && !rest.includes("--")) {
  args.push("--", "--test-threads=2");
}

const env = {
  ...process.env,
  // 测试临时目录挪到 D 盘的 target 下：跟着 cargo clean 一起消失，永不污染系统盘。
  TEMP: tmpRoot,
  TMP: tmpRoot,
  // 增量产物在「tauri dev（--no-default-features）」和「测试（默认 feature）」之间
  // 反复切会损坏，报 `invalid metadata files for crate nc_forge`。关掉最省心。
  CARGO_INCREMENTAL: "0",
  // 并发按内存定，不按核数：16 核 / 15.8GB 跑 16 路 rustc 会顶满。
  // 3 路冷编最低可用内存 3.0GB；4 路只剩 2.0GB，对这台常蓝屏的机器太紧。
  CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS || "3",
};

console.log(`[gate] cargo ${args.join(" ")}`);
console.log(`[gate] TEMP → ${tmpRoot}   jobs=${env.CARGO_BUILD_JOBS}`);

const startedAt = Date.now();
const r = spawnSync("cargo", args, { cwd: srcTauri, stdio: "inherit", env });

// 不论成败都清：失败用例留下的残骸正是长在 C 盘上的那些。
const after = wipeTmp();
console.log(
  `[gate] 收尾：清掉本轮产生的 ${after.removed} 个临时目录（${mb(after.bytes)}）——` +
    `不清理的话这些就会永久堆在系统盘的 %TEMP% 里`,
);

checkSystemTmpLeak(startedAt);
checkTargetSize();

if (r.error) {
  console.error(`[gate] 启动 cargo 失败：${r.error.message}`);
  process.exit(1);
}
process.exit(r.status ?? 1);

/**
 * 兜住「有人绕过 TEMP 重定向、直接往系统盘写」的情况（CLAUDE.md §8.3.4）。
 * 只看本工具自己的前缀，别的东西不归我们管。
 */
function checkSystemTmpLeak(since) {
  let hits = [];
  try {
    for (const name of readdirSync(systemTmp)) {
      if (!OWN_PREFIX.test(name)) continue;
      const st = statSync(join(systemTmp, name), { throwIfNoEntry: false });
      if (st && st.mtimeMs >= since - 2000) hits.push({ name, st });
    }
  } catch {
    return; // 系统临时目录读不动就算了，别让自检把门禁搞挂
  }
  if (hits.length === 0) return;
  let bytes = 0;
  for (const h of hits) bytes += sizeOf(join(systemTmp, h.name));
  console.log(
    `[gate] ⚠️ 有 ${hits.length} 个临时目录写到了 C 盘的 ${systemTmp}（合计 ${mb(bytes)}）——` +
      `说明有测试没走 TEMP 重定向或硬编码了路径，见 CLAUDE.md §8.3.4：`,
  );
  for (const h of hits.slice(0, 5)) console.log(`[gate]    ${h.name}`);
  if (hits.length > 5) console.log(`[gate]    …其余 ${hits.length - 5} 个`);
}

/** target/debug 体积自检（CLAUDE.md §8.3.3）：涨破 6GB 基本就是 debuginfo 又开回来了。 */
function checkTargetSize() {
  const dir = join(srcTauri, "target", "debug");
  if (!existsSync(dir)) return;
  let bytes = 0;
  try {
    bytes = sizeOf(dir);
  } catch {
    return;
  }
  const label = `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes > TARGET_BUDGET) {
    console.log(
      `[gate] ⚠️ target/debug 已 ${label}（预算 ${(TARGET_BUDGET / 1024 ** 3).toFixed(0)}GB）——` +
        `先查 deps 里的 .pdb 占比，多半是依赖的 debuginfo 被打开了，见 CLAUDE.md §8.3.3`,
    );
  } else {
    console.log(`[gate] target/debug ${label}（预算 6GB 以内）`);
  }
}
