import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { execFileSync } from "node:child_process";

import {
  CI_JOBS,
  PRECOMMIT,
  PRECOMMIT_FORBIDDEN,
  RELEASE_SCRIPTS,
  STEPS,
  SCOPES,
  stepById,
  stepsForScope,
  verifyReleaseScript,
  verifyWorkflow,
} from "./gate-plan.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

test("清单本身合法：id 唯一、scope 已知、cwd 存在、why 非空", () => {
  const ids = STEPS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "id 必须唯一，否则 --only 会选到两项");
  for (const s of STEPS) {
    assert.ok(s.scopes.length > 0, `${s.id} 没有 scope，永远不会跑`);
    for (const sc of s.scopes) assert.ok(SCOPES.includes(sc), `${s.id} 的 scope ${sc} 不在 SCOPES 里`);
    assert.ok(existsSync(resolve(repoRoot, s.cwd)), `${s.id} 的 cwd 不存在：${s.cwd}`);
    assert.ok(s.argv.length > 0, `${s.id} 没有命令`);
    assert.ok(s.why && s.why.length > 10, `${s.id} 缺少 why：半年后没人知道它为什么在`);
  }
  assert.equal(stepById("不存在的-id"), null);
});

test("两个 CI scope 都覆盖 Rust 侧，frontend 不混入 cargo", () => {
  const win = stepsForScope("win").map((s) => s.id);
  const mac = stepsForScope("mac").map((s) => s.id);
  assert.ok(win.includes("rust-test") && win.includes("clippy"));
  assert.deepEqual(mac, ["clippy", "rust-test"], "mac 只跑这两项，顺序按清单");
  for (const id of stepsForScope("frontend").map((s) => s.id)) {
    const argv = stepById(id).argv.join(" ");
    assert.ok(!argv.includes("cargo"), `frontend scope 里不该有 cargo：${id}`);
  }
});

test("真实的 build.yml 与清单一致", () => {
  const text = readFileSync(resolve(repoRoot, ".github/workflows/build.yml"), "utf8");
  const { errors, warnings } = verifyWorkflow(text);
  assert.deepEqual(errors, [], `workflow 与清单漂移了：\n${errors.join("\n")}`);
  assert.deepEqual(warnings, [], "不应有「CI 不覆盖」的告警");
});

/** 一张最小 workflow，用来单独验证校验逻辑本身。 */
const wf = (jobs) =>
  [
    "name: x",
    "on:",
    "  push:",
    "jobs:",
    ...Object.entries(jobs).flatMap(([name, body]) => [`  ${name}:`, "    runs-on: ubuntu-latest", "    steps:", "      - uses: actions/checkout@v5", ...body.map((b) => `      - name: step\n        run: ${b}`)]),
  ].join("\n");

/** 按 scope 生成一组合法 job 段。 */
const okJob = (scope) => stepsForScope(scope).map((s) => `node scripts/gate.mjs --only ${s.id}`);

test("缺一项就报缺", () => {
  const win = okJob("win").filter((l) => !l.includes("--only fmt"));
  const { errors } = verifyWorkflow(wf({ frontend: okJob("frontend"), test: win, "check-macos": okJob("mac") }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /test（scope=win）缺：fmt/);
});

test("多一项、顺序错、未知 id、同 job 重复都各自报错", () => {
  const frontend = okJob("frontend");
  const extra = [...frontend, "node scripts/gate.mjs --only rust-test"];
  assert.match(verifyWorkflow(wf({ frontend: extra, test: okJob("win"), "check-macos": okJob("mac") })).errors.join("\n"), /frontend（scope=frontend）多：rust-test/);

  const swapped = [frontend[1], frontend[0], ...frontend.slice(2)];
  assert.match(verifyWorkflow(wf({ frontend: swapped, test: okJob("win"), "check-macos": okJob("mac") })).errors.join("\n"), /顺序与清单不一致/);

  const typo = [...frontend, "node scripts/gate.mjs --only formato"];
  assert.match(verifyWorkflow(wf({ frontend: typo, test: okJob("win"), "check-macos": okJob("mac") })).errors.join("\n"), /不存在的 id → formato/);

  const twice = [...okJob("win"), "node scripts/gate.mjs --only fmt"];
  assert.match(verifyWorkflow(wf({ frontend: okJob("frontend"), test: twice, "check-macos": okJob("mac") })).errors.join("\n"), /同一个 id 跑了两遍 → fmt/);
});

test("job 里裸跑门禁命令会被拦（这是漂移的起点）", () => {
  const frontend = [...okJob("frontend"), "npm run tokens:check"];
  const { errors } = verifyWorkflow(wf({ frontend, test: okJob("win"), "check-macos": okJob("mac") }));
  assert.match(errors.join("\n"), /绕过了 gate\.mjs/);
  assert.match(errors.join("\n"), /npm run tokens:check/);
});

test("run: | 的多行块也会被扫到", () => {
  const body = [
    "      - name: multi",
    "        run: |",
    "          npm ci",
    "          cargo fmt --check",
    "          echo done",
  ];
  const text = ["jobs:", "  frontend:", "    steps:", ...body].join("\n");
  const { errors } = verifyWorkflow(text);
  assert.match(errors.join("\n"), /cargo fmt --check/);
});

test("缺少整个 job 时明确报出来", () => {
  const { errors } = verifyWorkflow(wf({ frontend: okJob("frontend") }));
  const joined = errors.join("\n");
  assert.match(joined, /找不到 job「test」/);
  assert.match(joined, /找不到 job「check-macos」/);
});

test("CI_JOBS 的键就是 workflow 里真实存在的 job", () => {
  const text = readFileSync(resolve(repoRoot, ".github/workflows/build.yml"), "utf8");
  for (const job of Object.keys(CI_JOBS)) {
    assert.ok(new RegExp(`^  ${job}:\\s*$`, "m").test(text), `workflow 里没有 job「${job}」`);
  }
});

test("pre-commit 的七项都来自清单、且不含重活", () => {
  const ids = PRECOMMIT.map((p) => p.id);
  // 顺序即契约：按耗时从短到长，便宜的先红。
  assert.deepEqual(
    ids,
    ["source-size", "component-size", "rust-tempdir", "tokens", "fmt", "ui-contract", "tsc"],
    "顺序按「快 → 慢」，别随手调",
  );
  for (const id of ids) assert.ok(stepById(id), `${id} 不在 STEPS 里，pre-commit 会跑空`);
  for (const id of PRECOMMIT_FORBIDDEN) {
    assert.ok(!ids.includes(id), `${id} 太重，不该进 pre-commit（钩子超 30 秒就会被 --no-verify 绕过）`);
  }
  for (const p of PRECOMMIT) assert.ok(p.match instanceof RegExp, `${p.id} 缺少 match：无法按暂存文件挑`);
});

test("pre-commit 的后缀匹配：改文档不跑，改代码按类型跑", () => {
  const hit = (file) => PRECOMMIT.filter((p) => p.match.test(file)).map((p) => p.id);
  assert.deepEqual(hit("docs/x.md"), [], "只改文档时七项都不跑");
  assert.deepEqual(hit("CHANGELOG.md"), []);
  // 写组件是最容易踩 300 行红线的地方，必须每次都扫。
  assert.deepEqual(hit("desktop/src/components/db/X.tsx"), ["component-size", "tokens", "ui-contract", "tsc"]);
  assert.deepEqual(hit("desktop/src/lib/db.ts"), ["component-size", "tsc"]);
  assert.deepEqual(hit("desktop/src-tauri/src/lib.rs"), ["source-size", "rust-tempdir", "fmt"]);
  assert.deepEqual(hit("desktop/src/db-console.css"), ["tokens", "ui-contract"]);
});

test("两个钩子都走 gate.mjs，且以可执行位入库", () => {
  for (const [hook, needle] of [
    ["pre-commit", /gate\.mjs --precommit/],
    ["pre-push", /gate\.mjs\b/],
  ]) {
    const file = resolve(repoRoot, ".githooks", hook);
    assert.ok(existsSync(file), `缺 .githooks/${hook}`);
    assert.match(readFileSync(file, "utf8"), needle, `${hook} 没有调 gate.mjs（清单真源在 gate-plan.mjs）`);

    // Windows 的 core.filemode=false 让 git add 不记录权限位；钩子一旦以 100644
    // 入库，Linux/macOS clone 出来 git 会**静默跳过**它，一项门禁都不跑。
    const staged = execFileSync("git", ["ls-files", "-s", `.githooks/${hook}`], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    if (staged) assert.ok(staged.startsWith("100755"), `${hook} 的索引模式是 ${staged.split(" ")[0]}，必须 100755`);
  }
});

// ── 发版脚本的裸命令守卫 ─────────────────────────────────────────────
// v0.5.0 的成因原样复现：release.mjs 里写的是 `cargo clippy --no-default-features`，
// CI 跑的是 `clippy --all-targets -- -D warnings`。本地绿、tag 构建红。
test("发版脚本里裸写 clippy 会被拦（v0.5.0 原样命令）", () => {
  const src = 'run("cargo clippy --no-default-features", path.join(DESKTOP, "src-tauri"));';
  const { errors } = verifyReleaseScript("release.mjs", src);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /绕过了 gate\.mjs/);
  assert.match(errors[0], /第 1 行/);
});

test("发版脚本里裸写 cargo test / npx tsc / npm run lint 都会拦", () => {
  const src = [
    'run("cargo test --no-default-features", x);',
    'run("npx tsc --noEmit", x);',
    'run("npm run lint", x);',
  ].join("\n");
  assert.equal(verifyReleaseScript("release.mjs", src).errors.length, 3);
});

test("注释里举例说明不算违规（否则改不了这类注释）", () => {
  const src = [
    "  // 以前这里写的是 cargo clippy --no-default-features，别抄回来",
    "   * cargo test --no-default-features 也不行",
    '  run("node scripts/gate.mjs", DESKTOP);',
  ].join("\n");
  assert.deepEqual(verifyReleaseScript("release.mjs", src).errors, []);
});

test("cargo check 不拦：它不是门禁项，只是 --skip-tests 的保底编译", () => {
  assert.deepEqual(verifyReleaseScript("release.mjs", 'run("cargo check --no-default-features", x);').errors, []);
});

test("真实的 release.mjs / reship.mjs 现在必须过守卫", () => {
  for (const name of RELEASE_SCRIPTS) {
    const file = resolve(here, "..", name);
    assert.ok(existsSync(file), `缺 ${name}`);
    assert.deepEqual(verifyReleaseScript(name, readFileSync(file, "utf8")).errors, []);
  }
});

// ── pre-commit 的构成（红线要在本地就红，不能等到发版） ─────────────────
test("component-size 必须在 pre-commit 里（300 行红线要在提交前就拦住）", () => {
  const hit = PRECOMMIT.find((p) => p.id === "component-size");
  assert.ok(hit, "component-size 不在 PRECOMMIT 里：v0.5.0 的 309 行 ResultTable 就是这么发出去的");
  // 写组件时的主战场是 .tsx；.ts 里的 hook 也扫行数，所以一起命中。
  assert.ok(hit.match.test("src/components/db/ResultTable.tsx"));
  assert.ok(hit.match.test("src/lib/big.ts"));
  assert.ok(!hit.match.test("src/styles/app.css"), "改 css 不该触发组件体量扫描");
});

test("source-size 必须在 pre-commit 里（.rs 600 行线要在提交前就拦住）", () => {
  const hit = PRECOMMIT.find((p) => p.id === "source-size");
  assert.ok(hit, "source-size 不在 PRECOMMIT 里：新写一个 800 行的 .rs 会一路绿灯到发版");
  assert.ok(hit.match.test("src-tauri/src/new_module.rs"));
  assert.ok(!hit.match.test("src-tauri/src/lib.ts"), "只改前端不该触发 Rust 体量扫描");
});

test("PRECOMMIT 里每一项的 id 都存在，且各自 match 是真正则", () => {
  for (const item of PRECOMMIT) {
    assert.ok(stepById(item.id), `PRECOMMIT 引用了清单里不存在的 id：${item.id}`);
    assert.ok(item.match instanceof RegExp, `${item.id} 的 match 不是正则`);
  }
});

test("重活不许进 PRECOMMIT（钩子超过 30s 就等于没有）", () => {
  const bad = PRECOMMIT.filter((p) => PRECOMMIT_FORBIDDEN.includes(p.id)).map((p) => p.id);
  assert.deepEqual(bad, [], `这些项会把提交拖到分钟级，请留给 pre-push / CI：${bad.join(", ")}`);
});

test("PRECOMMIT 按耗时从短到长排（便宜的先红，才不容易被 --no-verify）", () => {
  const order = PRECOMMIT.map((p) => p.id);
  const cost = { "source-size": 0, "component-size": 1, "rust-tempdir": 2, tokens: 3, fmt: 4, "ui-contract": 5, tsc: 6 };
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(cost[order[i - 1]] < cost[order[i]], `顺序反了：${order[i - 1]} 应排在 ${order[i]} 之前`);
  }
});

// ── pre-push 默认开启（2026-11-12 决定） ─────────────────────────────────
test("pre-push 默认开启：环境变量默认值必须是 1，且仍然调 gate.mjs", () => {
  const src = readFileSync(resolve(repoRoot, ".githooks/pre-push"), "utf8");
  assert.match(src, /NCFORGE_PUSH_GATE:-1/, "默认值被改回 0 了：push 时不会跑门禁");
  assert.ok(!/NCFORGE_PUSH_GATE:-0\}/.test(src), "还有默认关闭的写法");
  assert.match(src, /gate\.mjs/, "pre-push 必须走统一入口");
  // dev 探测只用于「失败后解释」，不能用来预判失败：2026-11-12 实测 dev 开着、
  // rust 零改动时 cargo test 通过（cargo 不必重写没变的产物）。预判会误拦。
  assert.match(src, /dev_running\(\)/, "缺 dev 运行探测：红了看不出是 dev 没停");
  const beforeGate = src.slice(0, src.indexOf("node desktop/scripts/gate.mjs"));
  assert.ok(
    !/exit 1/.test(beforeGate),
    "别在跑门禁之前预判失败：dev 在跑 ≠ cargo 会红（实测会过），误拦一次就会有人开始习惯性 NCFORGE_PUSH_GATE=0",
  );
  assert.match(src, /exit "\$status"/, "必须透传 gate.mjs 的退出码");
});

test("发版的两次 push 都跳过 pre-push（第 1 步已全量，别白等 24 分钟）", () => {
  const src = readFileSync(resolve(repoRoot, "desktop/scripts/release.mjs"), "utf8");
  const pushes = [...src.matchAll(/run\(`git push origin (?:\$\{tagName\}|main)`,\s*ROOT,\s*true,\s*PUSH_ENV\)/g)];
  assert.equal(pushes.length, 2, "main 与 tag 两次 push 都要带 PUSH_ENV，否则发版各等 12 分钟");
  assert.match(src, /NCFORGE_PUSH_GATE: "0"/);
});
