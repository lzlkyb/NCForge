#!/usr/bin/env node
/**
 * 跨 IPC 类型生成：Rust 结构体 → `src/lib/bindings.generated.ts`。
 *
 * 真源是 Rust 源码里带 `// @ts-mirror` 的 struct（解析规则见 `lib/ts-mirror.mjs`）。
 * 判据只有一条：**改一个 Rust 字段名，`tsc --noEmit` 当场红**——靠的是
 * `src/lib/bindings.check.ts` 里把生成物与手写类型做双向相等断言。
 *
 * 用法：
 *   node scripts/gen-bindings.mjs            # 生成
 *   node scripts/gen-bindings.mjs --check    # 只校验（pre-commit / CI），含棘轮
 *   node scripts/gen-bindings.mjs --update   # 生成并下调棘轮基线
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMirrors, renderBindings } from "./lib/ts-mirror.mjs";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const RUST_DIR = join(ROOT, "src-tauri", "src");
const OUT_FILE = join(ROOT, "src", "lib", "bindings.generated.ts");
const BASELINE = join(ROOT, "scripts", "bindings-baseline.json");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".rs")) out.push(p);
  }
  return out;
}

const check = process.argv.includes("--check");
const update = process.argv.includes("--update");

const sources = walk(RUST_DIR).map((f) => ({ file: relative(ROOT, f).split("\\").join("/"), text: readFileSync(f, "utf8") }));
const { structs, enums, errors } = parseMirrors(sources);

if (errors.length) {
  console.error("✗ ts-mirror 解析失败（宁可报错也不生成半对的类型）：");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
if (structs.length === 0) {
  console.error("✗ 一个被标记的结构体都没找到。要么标记丢了，要么解析坏了——两种都不该静默通过。");
  process.exit(1);
}

const generated = renderBindings(structs, enums);
const counts = Object.fromEntries(structs.map((s) => [s.name, s.fields.length]));
const summary = structs
  .map((s) => `  ${s.name.padEnd(24)} ${s.fields.length} 字段 · ${s.direction}`)
  .concat(enums.map((e) => `  ${e.name.padEnd(24)} ${e.variants.length} 变体 · enum`))
  .join("\n");

let baseline = {};
try {
  baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
} catch {
  baseline = {};
}

/** 棘轮：已镜像的结构体不许消失，字段数不许减少（减字段要 `--update` 明说）。 */
function ratchetFailures() {
  const bad = [];
  for (const [name, count] of Object.entries(baseline)) {
    if (!(name in counts)) bad.push(`${name}：基线里有，现在不见了（是删了类型还是把 @ts-mirror 丢了？）`);
    else if (counts[name] < count) bad.push(`${name}：字段数 ${count} → ${counts[name]}，少了 ${count - counts[name]} 个`);
  }
  return bad;
}

if (check) {
  let onDisk = "";
  try {
    onDisk = readFileSync(OUT_FILE, "utf8");
  } catch {
    console.error(`✗ ${relative(ROOT, OUT_FILE)} 不存在。跑 npm run bindings:generate。`);
    process.exit(1);
  }
  const stale = onDisk !== generated;
  const ratchet = ratchetFailures();
  if (stale || ratchet.length) {
    if (stale) {
      console.error(`✗ ${relative(ROOT, OUT_FILE)} 与 Rust 源码不一致。`);
      console.error("  改了 Rust 字段就要重跑：npm run bindings:generate（并同步修改手写类型，否则 tsc 会红）");
    }
    for (const r of ratchet) console.error(`✗ ${r}`);
    process.exit(1);
  }
  console.log(`✓ bindings 一致：${structs.length} 个结构体 / ${Object.values(counts).reduce((a, b) => a + b, 0)} 个字段`);
  process.exit(0);
}

writeFileSync(OUT_FILE, generated, "utf8");
if (update || Object.keys(baseline).length === 0) {
  writeFileSync(BASELINE, JSON.stringify(counts, null, 2) + "\n", "utf8");
}
const ratchet = update ? [] : ratchetFailures();
if (ratchet.length) {
  console.error("✗ 棘轮逆行（确有理由就 --update）：");
  for (const r of ratchet) console.error(`  - ${r}`);
  process.exit(1);
}
console.log(`✓ 已生成 ${relative(ROOT, OUT_FILE)}：${structs.length} 个结构体 / ${Object.values(counts).reduce((a, b) => a + b, 0)} 个字段`);
console.log(summary);
