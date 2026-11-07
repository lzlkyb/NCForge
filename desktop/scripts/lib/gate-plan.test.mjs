import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CI_JOBS, STEPS, SCOPES, stepById, stepsForScope, verifyWorkflow } from "./gate-plan.mjs";

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
