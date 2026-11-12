/**
 * 门禁清单的唯一真源，以及「清单 ↔ CI workflow」一致性校验。
 *
 * 为什么单独立文件：scripts/gate.mjs 是 CLI 壳，一 import 就该跑门禁；
 * 纯数据与纯函数放这里，scripts/lib/gate-plan.test.mjs 才能直接单测，
 * 不必 spawn 子进程。
 *
 * 背景（2026-11-06 的教训）：同一份门禁清单原本抄在三处 —— .githooks/pre-push
 * 的 sh 脚本、build.yml 的 frontend job、build.yml 的 test + check-macos。
 * 增删一项要改三个文件，改漏就是漂移：cargo fmt --check 从 11-05 起在 CI 里
 * 一次都没跑过，也没人发现。而「按记忆手动跑散落的 12 个命令」必然漏项
 * （那次漏了 knip / 设计 token / UI 约定 / 体积预算四项，push 后 CI 全红）。
 *
 * 现在的契约：
 *   · 增删门禁只改本文件的 STEPS；
 *   · CI 每步只引用 id（gate.mjs --only <id>），不写命令本身；
 *   · --verify-ci 断言「每个 job 的 id 序列 == 清单里该 scope 的 id 序列」，
 *     也断言 job 里没有绕开 gate.mjs 的裸门禁命令。这道断言本身是 CI 的一步，
 *     所以漂移会在下一次 CI 立刻红，而不是等人去数。
 */

/** CI 里承担门禁的 job → 它负责的 scope。改 workflow 的 job 名要同步这里。 */
export const CI_JOBS = {
  frontend: "frontend",
  test: "win",
  "check-macos": "mac",
};

/**
 * 门禁清单。数组顺序就是执行顺序，按「失败越快越靠前」排。
 *
 * 每项：
 *   id      稳定标识，CI 用它引用；改名等于改契约，--verify-ci 会红。
 *   name    人读名字（日志与 --list）。
 *   cwd     相对仓库根（不是相对 desktop/）。
 *   argv    命令。不经 shell，免得引号与平台差异；npm/npx 在 Windows 上由
 *           gate.mjs 自动换成 .cmd。
 *   scopes  谁跑它：frontend（CI ubuntu）/ win（CI windows）/ mac（CI macOS）。
 *           不带 --scope 时跑并集 —— 本地 pre-push 就是全量。
 *   why     半年后没人会记得它为什么在。写上。
 */
export const STEPS = [
  {
    id: "component-size",
    name: "组件体量门禁（行数 + 状态数）",
    cwd: "desktop",
    argv: ["node", "scripts/check-component-size.mjs"],
    scopes: ["frontend"],
    why: "规则 7 的机器执行版：行数 + 单文件 useState/useEffect 总数。存量走棘轮基线，新文件必须直接合规。",
  },
  {
    id: "knip",
    name: "knip 孤立文件 / 依赖",
    cwd: "desktop",
    argv: ["npm", "run", "orphans:check"],
    scopes: ["frontend"],
    why: "只看 files + dependencies：删了调用方忘了删实现会在这里红。未使用的 export/type 存量多，暂不纳入。",
  },
  {
    id: "contract",
    name: "Tauri 命令契约（Rust ↔ TS）",
    cwd: "desktop",
    argv: ["npm", "run", "contract:check"],
    scopes: ["frontend"],
    why: "真源是 main.rs 的 generate_handler!；生成物过期、登记了没定义、前端拼错命令名都在这里拦。",
  },
  {
    id: "tokens",
    name: "设计 token 棘轮",
    cwd: "desktop",
    argv: ["npm", "run", "tokens:check"],
    scopes: ["frontend"],
    why: "裸 hex 只许减不许增；新增颜色必须走 :root token。2026-11-06 就是这里红在一条 #d97706 上。",
  },
  {
    id: "ui-contract",
    name: "UI 约定棘轮",
    cwd: "desktop",
    argv: ["npm", "run", "ui:check"],
    scopes: ["frontend"],
    why: "缓动必须走 --ease* token；字号不得低于 10px。存量违规记基线，只许减。",
  },
  {
    id: "rust-tempdir",
    name: "Rust 测试临时目录棘轮",
    cwd: "desktop",
    argv: ["node", "scripts/check-rust-tempdir.mjs"],
    scopes: ["frontend"],
    why: "测试里裸用 std::env::temp_dir() 只许减不许增：macOS 的 /var→/private/var 与 Windows CI 的 8.3 短名会让拼出的路径与产品代码对不上，表现是「本地全绿、CI 红」。新测试用 crate::test_support::tmp()。纯文件扫描，不需要 Rust 工具链。",
  },
  {
    id: "fmt",
    name: "cargo fmt --check",
    cwd: "desktop/src-tauri",
    argv: ["cargo", "fmt", "--check"],
    scopes: ["win"],
    why: "在本轮之前 CI 与钩子都没跑它（CI 里从未存在，钩子从未安装）。最便宜的一项，放最前。",
  },
  {
    id: "machete",
    name: "cargo machete（未使用依赖）",
    cwd: "desktop/src-tauri",
    argv: ["cargo", "machete"],
    scopes: ["win"],
    why: "误报登记在 Cargo.toml 的 [package.metadata.cargo-machete]。需要 cargo install cargo-machete --locked。",
  },
  {
    id: "eslint",
    name: "eslint",
    cwd: "desktop",
    argv: ["npm", "run", "lint"],
    scopes: ["frontend"],
    why: "上它的唯一理由是 react-hooks 两条规则：依赖数组不全 / 调用顺序错会让闭包拿陈旧值，而 tsc 看不出来。存量违规在 eslint-suppressions.json（棘轮）。",
  },
  {
    id: "tsc",
    name: "前端类型 tsc --noEmit",
    cwd: "desktop",
    argv: [
      "npx",
      "tsc",
      "--noEmit",
      "--incremental",
      "--tsBuildInfoFile",
      "node_modules/.cache/tsc.tsbuildinfo",
    ],
    scopes: ["frontend"],
    why: "vite:build 自带 tsc，但单独跑一次能让类型错误早一步、单独报出来，而不是混在打包失败里。带增量缓存是为了它也能进 pre-commit：冷跑 ~23s，热跑 ~6s（tsbuildinfo 在 node_modules 下，不入库）。",
  },
  {
    id: "vitest",
    name: "前端单测 vitest",
    cwd: "desktop",
    argv: ["npm", "test", "--silent", "--", "--maxWorkers=2"],
    scopes: ["frontend"],
    why: "盖的是真机难复现的纯计算（更新状态机、错误分类、随包记录汇总）。pretest 会顺带跑 scripts/lib 的自测，包括本清单的一致性断言。",
  },
  {
    id: "clippy",
    name: "cargo clippy -D warnings（双平台）",
    cwd: "desktop",
    argv: [
      "node",
      "scripts/rust-gate.mjs",
      "clippy",
      "--all-targets",
      "--no-default-features",
      "--",
      "-D",
      "warnings",
    ],
    scopes: ["win", "mac"],
    why: "两个 CI job 同等严格。走 rust-gate 而不是裸 cargo：它会清测试临时目录、按内存限并发。",
  },
  {
    id: "rust-test",
    name: "cargo test（双平台）",
    cwd: "desktop",
    argv: ["node", "scripts/rust-gate.mjs", "test", "--no-default-features"],
    scopes: ["win", "mac"],
    why: "裸 cargo test 在 16 核 / 15.8GB 上会顶满内存，测试残留还会撑爆系统盘 %TEMP%（实测 5.12GB / 1981 个目录）。rust-gate 把临时目录钉到 target/test-tmp 并限并发。",
  },
  {
    id: "vite-build",
    name: "vite build",
    cwd: "desktop",
    argv: ["npm", "run", "vite:build"],
    scopes: ["frontend"],
    why: "体积预算必须基于真实产物，所以排在 bundle-budget 之前；它本身也是「能不能打包」的验证。",
  },
  {
    id: "bundle-budget",
    name: "JS 产物体积预算",
    cwd: "desktop",
    argv: ["npm", "run", "bundle:check"],
    scopes: ["frontend"],
    why: "2026-11-06 实测「本地全绿、CI 才红」的一项（超 75KB raw / 25KB gzip）。进清单是为了本地绿 == CI 绿。",
  },
];

/** 清单里声明的 CI scope 集合。 */
export const SCOPES = [...new Set(Object.values(CI_JOBS))];

/**
 * pre-commit 的六项：提交前只跑「纯扫描 + 秒级」的检查，重的留给 pre-push / CI。
 *
 * 为什么门槛是「纯扫描」而不是「重要不重要」：commit 比 push 频繁一个量级，
 * 钩子一旦超过 30 秒就会被 `--no-verify` 绕过，等于没有。所以这里只收**不需要
 * 编译、不需要跑测试树**的项——它们的耗时与代码体量无关，加进提交路径几乎免费。
 * 实测（2026-11-12，本机）：component-size 0.5s / rust-tempdir 1.1s / tokens 1.4s
 * / fmt 2s / ui-contract 2.2s / tsc 6s（冷 23s）；全部命中约 10s。
 *
 * 🔴 为什么 component-size 必须在这一层（2026-11-12 补）：300 行红线以前只在 CI
 * 和「发版跑的完整门禁」里检查，结果是 v0.5.0 把一个 309 行的 `ResultTable` 写完、
 * 提交、推主线、发版全程无人拦，直到手动补 mac 才在 frontend job 里红。红线这种
 * 「写的时候就该知道」的事，检查点越靠前越省事——它只要 0.5 秒。
 *
 * 为什么不进 pre-commit（都是「重活」，留在 pre-push 与 CI）：
 *   contract 10s（要连生成物一起比对）、knip 16s、eslint 5s+、vitest 9min、
 *   clippy / cargo test 数分钟。硬塞进来只会让人开始用 --no-verify。
 *
 * match 只按「暂存文件的后缀」判断这项要不要跑：没有相关改动就跳过，并在
 * 输出里说明跳了哪几项（免得让人以为六项都验过了）。故意不做依赖分析——
 * 宁可多跑一项，也不做会漏的判断。
 */
export const PRECOMMIT = [
  // 按耗时从短到长排：先红的那项越便宜，越不容易被 --no-verify 绕过。
  { id: "component-size", match: /\.(ts|tsx)$/ },
  { id: "rust-tempdir", match: /\.rs$/ },
  { id: "tokens", match: /\.(css|tsx)$/ },
  { id: "fmt", match: /\.rs$/ },
  { id: "ui-contract", match: /\.(css|tsx)$/ },
  { id: "tsc", match: /\.(ts|tsx|json)$/ },
];

/**
 * 明确不许进 pre-commit 的（重活）。pickSteps 不读它，测试用它守门：
 * 有人往 PRECOMMIT 里加了这些，钩子会从 10s 变成十几分钟，然后所有人开始
 * `--no-verify`——比没有钩子更糟，因为「以为验过了」。
 */
export const PRECOMMIT_FORBIDDEN = ["vitest", "clippy", "rust-test", "vite-build", "bundle-budget", "knip", "contract"];

/** 某个 scope 要跑的步骤（保持清单顺序）。 */
export function stepsForScope(scope) {
  return STEPS.filter((s) => s.scopes.includes(scope));
}

/** 按 id 找步骤。 */
export function stepById(id) {
  return STEPS.find((s) => s.id === id) ?? null;
}

/**
 * 把 workflow 切成 job → 段文本。只认 jobs: 之下缩进 2 的 `名字:`。
 * 不做完整 YAML 解析（不引依赖）：门禁只需要「哪个 job 里有哪几行」。
 */
export function parseWorkflowJobs(text) {
  const jobs = new Map();
  const lines = text.split(/\r?\n/);
  let inJobs = false;
  let current = null;
  let body = [];

  const flush = () => {
    if (current) jobs.set(current, body.join("\n"));
    body = [];
  };

  for (const line of lines) {
    if (!inJobs) {
      if (/^jobs:\s*$/.test(line)) inJobs = true;
      continue;
    }
    const m = /^ {2}([A-Za-z][A-Za-z0-9_-]*):\s*$/.exec(line);
    if (m) {
      flush();
      current = m[1];
      continue;
    }
    if (current) body.push(line);
  }
  flush();
  return jobs;
}

/** job 段里 gate.mjs --only 引用的 id，按出现顺序。 */
export function parseGateCalls(jobBody) {
  const ids = [];
  for (const m of jobBody.matchAll(/gate\.mjs\s+--only\s+([a-z0-9,-]+)/g)) {
    for (const id of m[1].split(",")) {
      if (id) ids.push(id);
    }
  }
  return ids;
}

/**
 * 不走 gate.mjs 的裸门禁命令。CI 里再写一遍命令本身就是漂移的起点
 * （命令改一处、CI 里那份不改 → 本地与 CI 跑的不是同一件东西）。
 * 输出形如「行号: 内容」。
 */
const RAW_GATE_PATTERNS = [
  /scripts\/check-[a-z-]+\.mjs/,
  /scripts\/gen-command-contract\.mjs/,
  /\bnpm run (lint|tokens:check|ui:check|contract:check|orphans:check|vite:build|bundle:check)\b/,
  /\bnpx (eslint|tsc|knip)\b/,
  /\bcargo (fmt|machete)\b/,
  /\bcargo (test|clippy)\b/,
];

/** 抓 job 段里所有 `run:` 的值（含 `run: |` 的多行块）。 */
function runCommands(jobBody) {
  const out = [];
  const lines = jobBody.split(/\r?\n/);
  let blockIndent = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = /^(\s*)run:\s*(.*)$/.exec(line);
    if (m) {
      const value = m[2].trim();
      if (value === "|" || value === ">" || value === "|-" || value === ">-") {
        blockIndent = m[1].length;
        continue;
      }
      out.push({ line: i + 1, text: value });
      blockIndent = -1;
      continue;
    }
    if (blockIndent >= 0) {
      const indent = /^\s*/.exec(line)[0].length;
      if (line.trim() === "") continue;
      if (indent > blockIndent) {
        out.push({ line: i + 1, text: line.trim() });
        continue;
      }
      blockIndent = -1;
    }
  }
  return out;
}

/** job 段里绕开 gate.mjs 的门禁命令。 */
export function findRawGateCommands(jobBody) {
  return runCommands(jobBody)
    .filter((c) => !c.text.includes("gate.mjs"))
    .filter((c) => RAW_GATE_PATTERNS.some((re) => re.test(c.text)))
    .map((c) => `第 ${c.line} 行: ${c.text}`);
}

/**
 * 发版脚本也要受同一条规则约束。
 *
 * 为什么：`release.mjs` 曾经自己拼 `cargo clippy --no-default-features`，而 CI
 * 跑的是 `clippy --all-targets -- -D warnings`——同一个检查两个真源。v0.5.0
 * 就是这样「本地全绿、tag 构建红在 clippy 上」，一个包都没出。发版路径能自己
 * 拼门禁命令，等于存在一条比 CI 宽松的路；靠注释提醒「记得参数一样」是记不
 * 住的，只能让脚本自己不许写。
 *
 * 只扫代码行：注释里举例说明「以前写的是 cargo clippy ...」不该被算违规。
 */
export const RELEASE_SCRIPTS = ["release.mjs", "reship.mjs"];

/** 脚本里绕开 gate.mjs 的门禁命令（输出形如「第 N 行: ...」）。 */
function findRawGateCommandsInScript(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t) return;
    if (/^(\/\/|\*|\/\*)/.test(t)) return; // 注释
    if (t.includes("gate.mjs")) return; // 走的就是统一入口
    // 双引号里的命令文本才可能是真命令；先剥掉字符串定界符外的说明文字没有意义，
    // 这里只要求「含命令且不是注释」，误报的代价是有人来改注释，漏报的代价是发版红。
    if (RAW_GATE_PATTERNS.some((re) => re.test(t))) out.push(`第 ${i + 1} 行: ${t}`);
  });
  return out;
}

/** 校验单个发版脚本。返回 { errors }，与 verifyWorkflow 同形。 */
export function verifyReleaseScript(name, text) {
  return {
    errors: findRawGateCommandsInScript(text).map(
      (bad) => `${name}：门禁命令绕过了 gate.mjs（清单在 desktop/scripts/lib/gate-plan.mjs）→ ${bad}`,
    ),
  };
}

/**
 * 校验 workflow 与清单一致。返回 { errors, warnings }，空 errors 即通过。
 *
 * 查四件事：
 *   1. CI_JOBS 里每个 job 存在，且它的 gate 步骤序列 == 清单里该 scope 的 id 序列
 *      （顺序也查：清单按「快 → 慢」排，CI 顺序漂了说明有人手改了步骤）；
 *   2. 引用的 id 都存在，且同一个 job 里不重复；
 *   3. job 里没有绕开 gate.mjs 的裸门禁命令；
 *   4. 清单里没有任何 CI scope 的项（只在本地跑）给出告警 —— 那意味着 CI 不覆盖它。
 */
export function verifyWorkflow(text) {
  const errors = [];
  const warnings = [];
  const jobs = parseWorkflowJobs(text);
  const known = new Set(STEPS.map((s) => s.id));

  if (jobs.size === 0) errors.push("解析不到任何 job：workflow 的 jobs: 段结构变了？");

  const byJob = new Map();
  for (const [job, body] of jobs) {
    const ids = parseGateCalls(body);
    if (ids.length) byJob.set(job, ids);

    // 只查门禁 job。发版 job（build-macos / build-windows）里的
    // `cargo test --release` 是打包流程的一部分（复用 release 编译产物），
    // 不是门禁，不该被这条规则拦下。
    if (!(job in CI_JOBS)) continue;

    for (const bad of findRawGateCommands(body)) {
      errors.push(`${job}：门禁命令绕过了 gate.mjs（清单在 desktop/scripts/lib/gate-plan.mjs）→ ${bad}`);
    }
    const dup = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
    for (const id of dup) errors.push(`${job}：同一个 id 跑了两遍 → ${id}`);
    for (const id of new Set(ids)) {
      if (!known.has(id)) errors.push(`${job}：引用了清单里不存在的 id → ${id}`);
    }
  }

  for (const [job, scope] of Object.entries(CI_JOBS)) {
    const ids = byJob.get(job);
    if (!ids) {
      errors.push(`workflow 里找不到 job「${job}」（或它没有任何 gate.mjs 步骤）`);
      continue;
    }
    const want = stepsForScope(scope).map((s) => s.id);
    const got = ids.filter((id) => known.has(id));
    const missing = want.filter((id) => !got.includes(id));
    const extra = got.filter((id) => !want.includes(id));
    if (missing.length) errors.push(`${job}（scope=${scope}）缺：${missing.join(", ")}`);
    if (extra.length) errors.push(`${job}（scope=${scope}）多：${extra.join(", ")}`);
    if (!missing.length && !extra.length && want.join() !== got.join()) {
      errors.push(
        `${job}（scope=${scope}）顺序与清单不一致：\n    期望 ${want.join(" → ")}\n    实际 ${got.join(" → ")}`,
      );
    }
  }

  const ciScopes = new Set(Object.values(CI_JOBS));
  for (const step of STEPS) {
    if (!step.scopes.some((sc) => ciScopes.has(sc))) {
      warnings.push(`「${step.id}」没有任何 CI scope（scopes=${step.scopes.join("/")}）——CI 不覆盖它`);
    }
  }

  return { errors, warnings };
}
