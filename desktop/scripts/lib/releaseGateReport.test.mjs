import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BUILD_JOB_NAMES,
  GATE_JOB_NAMES,
  describeVerdict,
  summarizeRunJobs,
} from "./releaseGateReport.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

const FE = "Frontend (tsc + vitest + build)";
const WIN = "Rust test suite (Windows)";
const MAC = "Rust check + test (macOS)";
const BWIN = "Build Windows exe + installer";
const BMAC = "Build macOS app (arm64)";

const job = (name, conclusion) => ({ name, conclusion });

test("全绿 + 产物齐 = ok", () => {
  const r = summarizeRunJobs([job(FE, "success"), job(WIN, "success"), job(BWIN, "success")]);
  assert.equal(r.verdict, "ok");
  assert.equal(r.gateGreen, true);
  assert.equal(r.buildOk, true);
  assert.equal(describeVerdict(r).level, "ok");
});

test("门禁红但产物齐 = gate-red（不阻断，但要说出来）", () => {
  const r = summarizeRunJobs([job(FE, "failure"), job(BWIN, "success")]);
  assert.equal(r.verdict, "gate-red");
  assert.equal(r.gateGreen, false);
  const d = describeVerdict(r);
  assert.equal(d.level, "warn");
  assert.match(d.title, /Frontend .* failure/);
  assert.match(d.hints.join(" "), /不阻断/);
});

test("门禁绿但产物没出全 = build-missing（这个该在镜像前拦住人）", () => {
  const r = summarizeRunJobs([job(FE, "success"), job(BWIN, "cancelled")]);
  assert.equal(r.verdict, "build-missing");
  assert.equal(describeVerdict(r).level, "error");
});

test("都没成 = both-bad", () => {
  const r = summarizeRunJobs([job(FE, "failure"), job(BWIN, "failure")]);
  assert.equal(r.verdict, "both-bad");
  assert.equal(describeVerdict(r).level, "error");
});

test("skipped 不算红：tag 触发跳过的 mac 门禁不该把结论说成红", () => {
  const r = summarizeRunJobs([job(FE, "success"), job(MAC, "skipped"), job(BWIN, "success")]);
  assert.equal(r.gateRed.length, 0);
  assert.equal(r.verdict, "ok");
  assert.match(describeVerdict(r).hints.join(" "), /Rust check \+ test \(macOS\)/);
});

test("拿到空列表不能说绿：没结论就当没验过", () => {
  const r = summarizeRunJobs([]);
  assert.equal(r.gateGreen, false);
  assert.equal(r.buildOk, false);
  assert.equal(r.verdict, "no-gate-data");
});

test("只认清单里的 job 名，多出来的（含产物 job）不会把门禁说成绿", () => {
  const r = summarizeRunJobs([job(BWIN, "success"), job("Some unrelated job", "success")]);
  assert.equal(r.gateGreen, false);
  assert.equal(r.verdict, "no-gate-data");
});

test("两个产物 job 只成了一个 = build-missing（残缺 Release 镜像过去比不镜像更糟）", () => {
  const r = summarizeRunJobs([job(FE, "success"), job(BWIN, "success"), job(BMAC, "cancelled")]);
  assert.equal(r.buildOk, false);
  assert.equal(r.verdict, "build-missing");
});

test("只跑了 Windows 产物（本轮没带 mac）不算缺产物", () => {
  // build-macos 只在 with_macos=true 时出现；那时 run 里压根没有这个 job，
  // 不能因为「清单里列了 mac」就判缺产物，否则每次普通发版都会中止镜像。
  const r = summarizeRunJobs([job(FE, "success"), job(BWIN, "success")]);
  assert.equal(r.buildOk, true);
  assert.equal(r.verdict, "ok");
});

test("GitHub 报告 macOS 打包 skipped 时，Windows 产物仍可镜像", () => {
  const r = summarizeRunJobs([job(FE, "success"), job(BWIN, "success"), job(BMAC, "skipped")]);
  assert.equal(r.verdict, "ok");
});

test("运行中的门禁既不报绿，也不报产物缺失", () => {
  const r = summarizeRunJobs([job(FE, "success"), { name: WIN, status: "in_progress" }, job(BWIN, "success")]);
  assert.equal(r.gateGreen, false);
  assert.equal(r.verdict, "pending");
  assert.match(describeVerdict(r).title, /仍在运行/);
});

test("🔴 job 名必须与 build.yml 里的 name: 一致（改名会让核对静默失配）", () => {
  const wf = readFileSync(resolve(repoRoot, ".github/workflows/build.yml"), "utf8");
  for (const name of [...GATE_JOB_NAMES, ...BUILD_JOB_NAMES]) {
    assert.ok(wf.includes(`name: ${name}`), `build.yml 里找不到 job「${name}」，核对会失配`);
  }
});
