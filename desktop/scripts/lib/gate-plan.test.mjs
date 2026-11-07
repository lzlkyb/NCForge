import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { execFileSync } from "node:child_process";

import { CI_JOBS, PRECOMMIT, STEPS, SCOPES, stepById, stepsForScope, verifyWorkflow } from "./gate-plan.mjs";

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

test("pre-commit 只有三项、都来自清单、且不含慢项", () => {
  const ids = PRECOMMIT.map((p) => p.id);
  assert.deepEqual(ids, ["tokens", "fmt", "tsc"], "顺序按「快 → 慢」，别随手调");
  for (const id of ids) assert.ok(stepById(id), `${id} 不在 STEPS 里，pre-commit 会跑空`);
  const slow = ["eslint", "vitest", "clippy", "rust-test", "vite-build", "bundle-budget", "knip", "contract", "machete", "component-size", "ui-contract", "rust-tempdir"];
  for (const id of slow) assert.ok(!ids.includes(id), `${id} 太慢，不该进 pre-commit（钩子超 30 秒就会被 --no-verify 绕过）`);
  for (const p of PRECOMMIT) assert.ok(p.match instanceof RegExp, `${p.id} 缺少 match：无法按暂存文件挑`);
});

test("pre-commit 的后缀匹配：改文档不跑，改代码按类型跑", () => {
  const hit = (file) => PRECOMMIT.filter((p) => p.match.test(file)).map((p) => p.id);
  assert.deepEqual(hit("docs/x.md"), [], "只改文档时三项都不跑");
  assert.deepEqual(hit("CHANGELOG.md"), []);
  assert.deepEqual(hit("desktop/src/components/db/X.tsx"), ["tokens", "tsc"]);
  assert.deepEqual(hit("desktop/src/lib/db.ts"), ["tsc"]);
  assert.deepEqual(hit("desktop/src-tauri/src/lib.rs"), ["fmt"]);
  assert.deepEqual(hit("desktop/src/db-console.css"), ["tokens"]);
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
