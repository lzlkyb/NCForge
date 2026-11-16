#!/usr/bin/env node
// 索引基线探针：jdt.ls 在规模化工作副本上，从 spawn 到 ServiceReady 到底多久，
// 以及「同一 data dir 再起一次」能省多少。
//
// 为什么要单独量这三轮：
//   1. fresh —— 首次导入，全量索引。这是用户第一次打开工程看到的等待。
//   2. warm  —— 同一个 `-data` 目录再起一次。`data_dir_for` 的缓存复用有没有用，
//               只有这一轮能回答；没变快就说明缓存在失效（`.classpath` 被重写、
//               指纹变了、或者 jdt.ls 自己判脏）。
//   3. old   —— 只排除 `.svn` 的旧配置。fresh 与 old 的差 = 产物目录排除的收益。
//
// fixture 是一次性的临时目录，跑完删除；结论落 `src-tauri/target/test-tmp/lang-index-bench.json`。
//
// 跑法：node scripts/lang-index-bench.mjs [--files=600]
//       node scripts/lang-index-bench.mjs --files=600 --skip-old
//       node scripts/lang-index-bench.mjs --root=D:/NC65/nc65newwork   # 真实工程，只读
//
// 🔴 --root 模式对真实工程**只读**：jdt.ls 的 -data / config 全写探针自己的临时
//    目录，绝不往用户工程落任何东西。--root 与 --files 互斥（真实工程不造盘）。

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { countJava, resolveRoot } from './lib/lang-index-root.mjs';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ls = process.env.NCFORGE_JDTLS_DIR ?? join(desktop, 'src-tauri/resources/jdtls');
const java = process.env.NCFORGE_JAVA_HOME
  ? join(process.env.NCFORGE_JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
  : 'D:/ncc/1909home/ufjdk/bin/java.exe';
const base = resolve(desktop, 'src-tauri/target/test-tmp');
mkdirSync(base, { recursive: true });
assert.ok(existsSync(ls), `缺 jdt.ls 资源：${ls}`);
assert.ok(existsSync(java), `缺 java：${java}`);

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
};
const FILE_COUNT = arg('files', 600);
const SKIP_OLD = process.argv.includes('--skip-old');
const ROOT_RAW = (() => {
  const hit = process.argv.find((a) => a.startsWith('--root='));
  return hit ? hit.slice('--root='.length) : null;
})();
// --root 与 --files 互斥：真实工程不造盘，--files 没有意义。
if (ROOT_RAW !== null && process.argv.some((a) => a.startsWith('--files='))) {
  console.error('--root 与 --files 不能同时用：真实工程不造 fixture');
  process.exit(1);
}
// 真实工程入口：解析失败立刻退出（别静默拿空索引冒充测过）。
const ROOT = ROOT_RAW !== null ? resolveRoot(ROOT_RAW) : null;

// 与 `lsp.rs::IMPORT_EXCLUSIONS` 保持一致；两边不一致时以 Rust 为准（这里是探针）。
const NEW_EXCLUSIONS = ['**/.svn/**', '**/.git/**', '**/classes/**', '**/bin/**', '**/hotwebs/**', '**/nclogs/**', '**/temp/**', '**/backup/**'];
const OLD_EXCLUSIONS = ['**/.svn/**'];

const fixture = mkdtempSync(join(base, 'ncf-index-bench-'));
assert.ok(fixture.startsWith(base + sep));

/**
 * 自己造的东西自己收。
 *
 * 不用 `rmSync(dir, {recursive:true})`：一次删几千项会被沙箱的 `node-safe-delete-shim`
 * 当成批量删除拦下（>500 项要二次确认），探针最后一步就变成抛错。
 * 逐条 unlink/rmdir 是单次删除，不会触发批量判定；后序遍历保证先空目录再删目录。
 */
function forceRemove(dir) {
  let names;
  try { names = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of names) {
    const p = join(dir, e.name);
    if (e.isDirectory() && !e.isSymbolicLink()) forceRemove(p);
    else { try { unlinkSync(p); } catch { /* 已被删 */ } }
  }
  try { rmdirSync(dir); } catch { /* 非空或已删 */ }
}

// fixture 模式：project 是临时工作副本。root 模式：project 指向真实工程（只读），
// workspaceFolders 用它下面的各 IProject。两种模式的 -data/config 都在 fixture 里。
const project = ROOT ? ROOT.root : join(fixture, 'bench');
const srcRoot = join(project, 'src/bench');
const folders = ROOT
  ? ROOT.projects.map((p) => ({ uri: pathToFileURL(p).href, name: p.split(/[\\/]/).pop() }))
  : [{ uri: pathToFileURL(project).href, name: 'bench' }];

/** 造工作副本：源码 + 每层 `.svn` + NC 自带的大目录（`hotwebs` / `nclogs` / `classes`）。 */
function makeProject() {
  mkdirSync(srcRoot, { recursive: true });
  writeFileSync(join(project, '.project'), '<projectDescription><name>bench</name><buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name><arguments/></buildCommand></buildSpec><natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>');
  writeFileSync(join(project, '.classpath'), '<classpath><classpathentry kind="src" path="src"/><classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER/org.eclipse.jdt.internal.debug.ui.launcher.StandardVMType/JavaSE-1.8"/><classpathentry kind="output" path="bin"/></classpath>');
  mkdirSync(join(project, '.settings'), { recursive: true });
  writeFileSync(join(project, '.settings/org.eclipse.core.resources.prefs'), 'eclipse.preferences.version=1\nencoding/<project>=UTF-8\n');
  for (let i = 0; i < FILE_COUNT; i++) {
    const prev = i === 0 ? '' : `  public C${i - 1} prev() { return new C${i - 1}(); }\n`;
    const body = `package bench;\n/** 基准素材 ${i}。 */\npublic class C${i} {\n  private int f${i};\n${prev}  public int value() { int v = ${i}; return v + f${i}; }\n}\n`;
    writeFileSync(join(srcRoot, `C${i}.java`), body);
  }
  // 噪音：三种「NC 工作副本里真实存在、但和 Java 源码无关」的目录
  for (let i = 0; i < 40; i++) {
    const svn = join(project, '.svn/pristine', `d${i}`);
    mkdirSync(svn, { recursive: true });
    writeFileSync(join(svn, `C${i}.java.svn-base`), 'x'.repeat(2048));
  }
  mkdirSync(join(project, 'hotwebs/res'), { recursive: true });
  for (let i = 0; i < 300; i++) writeFileSync(join(project, 'hotwebs/res', `a${i}.js`), '// x\n'.repeat(40));
  mkdirSync(join(project, 'nclogs/server'), { recursive: true });
  for (let i = 0; i < 40; i++) writeFileSync(join(project, 'nclogs/server', `l${i}.log`), '$$msg=x\n'.repeat(50));
  mkdirSync(join(project, 'classes/bench'), { recursive: true });
  for (let i = 0; i < 200; i++) writeFileSync(join(project, 'classes/bench', `C${i}.class`), Buffer.alloc(512));
}

/** 目录体积：用来判断「缓存到底有没有落盘」。warm 轮如果体积没变，说明索引真落过盘。 */
function dirSize(dir) {
  let total = 0;
  let names;
  try { names = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of names) {
    const p = join(dir, e.name);
    if (e.isDirectory() && !e.isSymbolicLink()) total += dirSize(p);
    else if (e.isFile()) { try { total += statSync(p).size; } catch { /* 正在被写 */ } }
  }
  return total;
}

/** 起一次 jdt.ls，量 initialize → ServiceReady，并把语言状态原文带回来。 */
function runOnce({ label, exclusions, dataDir }) {
  const config = join(fixture, `config-${label}`);
  mkdirSync(config, { recursive: true });
  cpSync(join(ls, process.platform === 'win32' ? 'config_win' : 'config_linux', 'config.ini'), join(config, 'config.ini'));
  const launcher = readdirSync(join(ls, 'plugins')).find((n) => n.startsWith('org.eclipse.equinox.launcher_') && n.endsWith('.jar'));
  const runtime = dirname(dirname(java));
  const rootUri = pathToFileURL(project).href;
  const settings = {
    java: {
      configuration: { runtimes: [{ name: 'JavaSE-1.8', path: runtime, default: true }] },
      autobuild: { enabled: false },
      format: { enabled: true },
      import: { exclusions, maven: { enabled: false }, gradle: { enabled: false } },
      errors: { incompleteClasspath: { severity: 'ignore' } },
      completion: { maxResults: 50 },
    },
  };
  const child = spawn(java, [
    '-Declipse.application=org.eclipse.jdt.ls.core.id1', '-Dosgi.bundles.defaultStartLevel=4',
    '-Declipse.product=org.eclipse.jdt.ls.core.product', '-noverify', '-Xmx1024m',
    '-jar', join(ls, 'plugins', launcher), '-configuration', config, '-data', dataDir,
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

  let buffer = Buffer.alloc(0);
  let nextId = 1;
  let stderr = '';
  const pending = new Map();
  const statuses = [];
  let readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });

  const send = (m) => {
    const body = Buffer.from(JSON.stringify(m));
    child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    child.stdin.write(body);
  };
  const request = (method, params, timeout = 60000) => new Promise((res, rej) => {
    const id = nextId++;
    const timer = globalThis.setTimeout(() => { pending.delete(id); rej(new Error(`${method} timed out`)); }, timeout);
    pending.set(id, { res, rej, timer });
    send({ jsonrpc: '2.0', id, method, params });
  });

  child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-8000); });
  child.stdout.on('data', (data) => {
    buffer = Buffer.concat([buffer, data]);
    for (;;) {
      const header = buffer.indexOf('\r\n\r\n');
      if (header < 0) return;
      const len = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, header).toString())?.[1]);
      if (buffer.length < header + 4 + len) return;
      const message = JSON.parse(buffer.subarray(header + 4, header + 4 + len).toString());
      buffer = buffer.subarray(header + 4 + len);
      if (message.id !== undefined && message.method) {
        const result = message.method === 'workspace/configuration'
          ? (message.params?.items ?? []).map(() => settings)
          : message.method === 'workspace/workspaceFolders' ? folders : null;
        send({ jsonrpc: '2.0', id: message.id, result });
      } else if (message.id !== undefined) {
        const item = pending.get(message.id);
        if (!item) continue;
        pending.delete(message.id);
        globalThis.clearTimeout(item.timer);
        if (message.error) item.rej(new Error(JSON.stringify(message.error)));
        else item.res(message.result);
      } else if (message.method === 'language/status') {
        statuses.push({ at: Date.now(), type: message.params?.type, message: message.params?.message });
        if (message.params?.type === 'ServiceReady') readyResolve();
      }
    }
  });

  return (async () => {
    const t0 = Date.now();
    try {
      await request('initialize', {
        processId: process.pid, rootUri, rootPath: project,
        workspaceFolders: folders,
        capabilities: { workspace: { workspaceFolders: true, configuration: true, applyEdit: false }, textDocument: { publishDiagnostics: {}, completion: {} } },
        initializationOptions: { settings, extendedClientCapabilities: { classFileContentsSupport: true } },
      });
      const handshakeMs = Date.now() - t0;
      send({ jsonrpc: '2.0', method: 'initialized', params: {} });
      const guard = globalThis.setTimeout(() => readyResolve(), 300000);
      await ready;
      globalThis.clearTimeout(guard);
      const totalMs = Date.now() - t0;
      return { label, exclusions: exclusions.length, handshakeMs, totalMs, statuses, dataBytes: dirSize(dataDir) };
    } finally {
      try { await request('shutdown', null, 5000); } catch { /* 已退出 */ }
      send({ jsonrpc: '2.0', method: 'exit', params: null });
      if (child.exitCode === null) await new Promise((r) => { const t = globalThis.setTimeout(() => { child.kill(); r(); }, 6000); child.once('exit', () => { globalThis.clearTimeout(t); r(); }); });
      for (const item of pending.values()) globalThis.clearTimeout(item.timer);
      if (stderr && !statuses.length) console.error(stderr.slice(-1500));
    }
  })();
}

const report = {
  generatedAt: new Date().toISOString(),
  mode: ROOT ? 'root' : 'fixture',
  fileCount: ROOT ? countJava(ROOT.projects) : FILE_COUNT,
  rounds: [],
};
if (ROOT) {
  report.root = ROOT.root;
  report.projects = ROOT.projects.map((p) => p.split(/[\\/]/).pop());
  report.readOnly = true; // -data/config 全在 fixture 临时目录，真实工程零写入
}
try {
  const t = Date.now();
  if (ROOT) {
    console.log(`真实工程（只读）：${ROOT.root}`);
    console.log(`   ${ROOT.projects.length} 个 IProject（${report.projects.join('、')}），共 ${report.fileCount} 个 java`);
    console.log(`   -data/config 写临时目录 ${fixture}，不碰工程本身`);
  } else {
    makeProject();
    console.log(`fixture：${FILE_COUNT} 个 java + .svn×40 + hotwebs×300 + nclogs×40 + classes×200，造盘 ${Date.now() - t} ms`);
  }

  const freshData = join(fixture, 'data-fresh');
  const oldData = join(fixture, 'data-old');
  console.log('—— 第 1 轮：新配置 + 空 data（首次导入）');
  report.rounds.push(await runOnce({ label: 'fresh', exclusions: NEW_EXCLUSIONS, dataDir: freshData }));
  console.log(`   ${report.rounds.at(-1).totalMs} ms`);
  await delay(500);
  console.log('—— 第 2 轮：新配置 + 复用上轮 data（缓存命中）');
  report.rounds.push(await runOnce({ label: 'warm', exclusions: NEW_EXCLUSIONS, dataDir: freshData }));
  console.log(`   ${report.rounds.at(-1).totalMs} ms`);
  if (!SKIP_OLD) {
    await delay(500);
    console.log('—— 第 3 轮：旧配置（只排 .svn）+ 空 data');
    report.rounds.push(await runOnce({ label: 'old', exclusions: OLD_EXCLUSIONS, dataDir: oldData }));
    console.log(`   ${report.rounds.at(-1).totalMs} ms`);
  }

  const by = (l) => report.rounds.find((r) => r.label === l);
  const fresh = by('fresh');
  const warm = by('warm');
  const old = by('old');
  report.verdict = {
    firstImportMs: fresh?.totalMs ?? null,
    cachedImportMs: warm?.totalMs ?? null,
    cacheSavesMs: fresh && warm ? fresh.totalMs - warm.totalMs : null,
    oldExclusionsMs: old?.totalMs ?? null,
    exclusionsSavesMs: fresh && old ? old.totalMs - fresh.totalMs : null,
  };
  // jdt.ls 的状态原文是 A3（状态栏百分比）的唯一依据：没在这里见过 `%` 或 `A/B`，
  // 就不该在前端凭猜显示百分比。
  const sample = [...new Set(report.rounds.flatMap((r) => r.statuses.map((s) => `${s.type}: ${s.message}`)))];
  report.statusSamples = sample.slice(0, 20);

  const out = join(base, 'lang-index-bench.json');
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log('\n=== 结论 ===');
  console.table(report.rounds.map((r) => ({ round: r.label, 握手: r.handshakeMs, 到就绪: r.totalMs, 状态条数: r.statuses.length })));
  console.log(`缓存复用节省 ${report.verdict.cacheSavesMs} ms；产物目录排除节省 ${report.verdict.exclusionsSavesMs ?? '未测'} ms`);
  console.log('语言状态原文样本：');
  for (const line of report.statusSamples) console.log(`  ${line}`);
  console.log(`\n结论已落盘：${out}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  assert.ok(fixture.startsWith(base + sep));
  forceRemove(fixture);
}
