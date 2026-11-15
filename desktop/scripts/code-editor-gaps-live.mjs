#!/usr/bin/env node
// 编辑器缺口探针：一次启动 jdt.ls，把「方案里说先验后做」的四项一次问清楚。
//
//   C1 诊断抑制 —— jdt.ls 是否已下发带 @SuppressWarnings 的 quick fix
//   C2 格式化   —— format.enabled 已开，是否真返回非空 TextEdit
//   C4 Linked Editing —— 是否声明 capability 且真返回联动 range
//   A0 基线     —— 补全 p50（冷/热）、didOpen → 首次诊断延迟、大文件代价
//
// 只读：不发 didChange、不落盘改源码。结论同时打到 stdout 和
// `src-tauri/target/test-tmp/editor-gaps.json`。
//
// 跑法：node scripts/code-editor-gaps-live.mjs

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ls = process.env.NCFORGE_JDTLS_DIR ?? join(desktop, 'src-tauri/resources/jdtls');
const java = process.env.NCFORGE_JAVA_HOME
  ? join(process.env.NCFORGE_JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
  : 'D:/ncc/1909home/ufjdk/bin/java.exe';
const base = resolve(desktop, 'src-tauri/target/test-tmp');
mkdirSync(base, { recursive: true });
assert.ok(existsSync(ls), `缺 jdt.ls 资源：${ls}`);
assert.ok(existsSync(java), `缺 java：${java}`);

const fixture = mkdtempSync(join(base, 'ncf-editor-gaps-'));
assert.ok(fixture.startsWith(base + sep));
const project = join(fixture, 'gaps');
const src = join(project, 'src/p');
mkdirSync(src, { recursive: true });

// 一个文件同时提供四个场景的素材
const GAPS = `package p;
import java.util.List;
import java.util.Map;
public class Gaps {
  private int unusedField;
  public int unusedLocal() {
    int unusedLocal = 42;
    return 1;
  }
  public void unchecked(List list) {
      list.add("x");
  }
  public String formatTarget() {
      if(true){return "x";}else{return "y";}
  }
  public int linkedTarget(int alpha, int beta) {
      int gamma = alpha + beta;
      return gamma;
  }
}
`;
const gapsFile = join(src, 'Gaps.java');
writeFileSync(gapsFile, GAPS);

// 大文件：6000 行上下，用来量 didOpen → 首次诊断的代价（A4 阈值的依据）
const bigLines = ['package p;', 'public class Big {'];
for (let i = 0; i < 6000; i++) bigLines.push(`  public int m${i}(int a) { int b = a + ${i}; return b; }`);
bigLines.push('}');
const bigFile = join(src, 'Big.java');
writeFileSync(bigFile, bigLines.join('\n') + '\n');

writeFileSync(join(project, '.project'), '<projectDescription><name>gaps</name><projects/><buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name><arguments/></buildCommand></buildSpec><natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>');
writeFileSync(join(project, '.classpath'), '<classpath><classpathentry kind="src" path="src"/><classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER/org.eclipse.jdt.internal.debug.ui.launcher.StandardVMType/JavaSE-1.8"/><classpathentry kind="output" path="bin"/></classpath>');
mkdirSync(join(project, '.settings'));
writeFileSync(join(project, '.settings/org.eclipse.core.resources.prefs'), 'eclipse.preferences.version=1\nencoding/<project>=UTF-8\n');

const config = join(fixture, 'config');
mkdirSync(config);
copyFileSync(join(ls, process.platform === 'win32' ? 'config_win' : 'config_linux', 'config.ini'), join(config, 'config.ini'));
const launcher = readdirSync(join(ls, 'plugins')).find((n) => n.startsWith('org.eclipse.equinox.launcher_') && n.endsWith('.jar'));
assert.ok(launcher, 'jdt.ls plugins 里没有 equinox launcher');

const runtime = dirname(dirname(java));
const rootUri = pathToFileURL(project).href;
const uriOf = (file) => pathToFileURL(file).href;
const settings = {
  java: {
    configuration: { runtimes: [{ name: 'JavaSE-1.8', path: runtime, default: true }] },
    autobuild: { enabled: false },
    format: { enabled: true },
    errors: { incompleteClasspath: { severity: 'ignore' } },
  },
};

const child = spawn(java, [
  '-Declipse.application=org.eclipse.jdt.ls.core.id1',
  '-Dosgi.bundles.defaultStartLevel=4',
  '-Declipse.product=org.eclipse.jdt.ls.core.product',
  '-noverify', '-Xmx512m',
  '-jar', join(ls, 'plugins', launcher),
  '-configuration', config, '-data', join(fixture, 'data'),
], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

let buffer = Buffer.alloc(0);
let nextId = 1;
let stderr = '';
const pending = new Map();
const diagnostics = new Map();
const diagWaiters = new Map();
let readyResolve;
const ready = new Promise((r) => { readyResolve = r; });

function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  child.stdin.write(body);
}
function request(method, params, timeout = 60000) {
  return new Promise((resolveP, rejectP) => {
    const id = nextId++;
    const timer = globalThis.setTimeout(() => {
      pending.delete(id);
      rejectP(new Error(`${method} timed out\n${stderr.slice(-2000)}`));
    }, timeout);
    pending.set(id, { resolve: resolveP, reject: rejectP, timer });
    send({ jsonrpc: '2.0', id, method, params });
  });
}
function notify(method, params) { send({ jsonrpc: '2.0', method, params }); }

function onDiagnostics(params) {
  const uri = params.uri.toLowerCase();
  diagnostics.set(uri, params.diagnostics ?? []);
  const waiters = diagWaiters.get(uri);
  if (waiters) { diagWaiters.delete(uri); for (const w of waiters) w(); }
}
function waitDiagnostics(uri, timeoutMs) {
  const key = uri.toLowerCase();
  if (diagnostics.has(key)) return Promise.resolve(diagnostics.get(key));
  return new Promise((resolveP, rejectP) => {
    const list = diagWaiters.get(key) ?? [];
    const timer = globalThis.setTimeout(() => rejectP(new Error(`诊断超时：${key}`)), timeoutMs);
    list.push(() => { globalThis.clearTimeout(timer); resolveP(diagnostics.get(key)); });
    diagWaiters.set(key, list);
  });
}

child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-16000); });
child.stdout.on('data', (data) => {
  buffer = Buffer.concat([buffer, data]);
  for (;;) {
    const header = buffer.indexOf('\r\n\r\n');
    if (header < 0) return;
    const match = /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, header).toString());
    if (!match) { buffer = buffer.subarray(header + 4); continue; }
    const length = Number(match[1]);
    if (buffer.length < header + 4 + length) return;
    const message = JSON.parse(buffer.subarray(header + 4, header + 4 + length).toString());
    buffer = buffer.subarray(header + 4 + length);
    if (message.id !== undefined && message.method) {
      let result = null;
      if (message.method === 'workspace/configuration') result = (message.params?.items ?? []).map(() => settings);
      if (message.method === 'workspace/workspaceFolders') result = [{ uri: rootUri, name: 'gaps' }];
      if (message.method === 'workspace/applyEdit') result = { applied: false, failureReason: 'probe never applies server edits' };
      send({ jsonrpc: '2.0', id: message.id, result });
    } else if (message.id !== undefined) {
      const item = pending.get(message.id);
      if (!item) continue;
      pending.delete(message.id);
      globalThis.clearTimeout(item.timer);
      if (message.error) item.reject(new Error(JSON.stringify(message.error)));
      else item.resolve(message.result);
    } else if (message.method === 'language/status' && message.params?.type === 'ServiceReady') {
      readyResolve();
    } else if (message.method === 'textDocument/publishDiagnostics') {
      onDiagnostics(message.params);
    }
  }
});
child.on('exit', (code) => {
  for (const item of pending.values()) { globalThis.clearTimeout(item.timer); item.reject(new Error(`JDT exited ${code}`)); }
  pending.clear();
});

const gapsUri = uriOf(gapsFile);
const bigUri = uriOf(bigFile);
const report = {
  generatedAt: new Date().toISOString(),
  linkedEditing: { capability: null, requestOk: false, ranges: null },
  format: { fullEdits: 0, fullChanged: false, rangeEdits: 0 },
  suppressWarnings: { diagnostics: [], actionKinds: [], actionTitles: [], suppressTitles: [], found: false },
  completion: { coldMs: null, samples: 0, p50Ms: null, minMs: null, maxMs: null },
  diagnosticsLatency: { gapsMs: null, bigFileMs: null, bigFileLines: bigLines.length },
  initializeMs: null,
};

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const lineAt = (token) => {
  const index = GAPS.indexOf(token);
  assert.ok(index >= 0, `素材里没有 ${token}`);
  const before = GAPS.slice(0, index);
  const lines = before.split('\n');
  return { line: lines.length - 1, character: lines.at(-1).length };
};

try {
  const t0 = Date.now();
  const initialized = await request('initialize', {
    processId: process.pid,
    rootUri, rootPath: project,
    workspaceFolders: [{ uri: rootUri, name: 'gaps' }],
    capabilities: {
      workspace: { workspaceFolders: true, configuration: true, applyEdit: false, workspaceEdit: { documentChanges: true } },
      textDocument: {
        publishDiagnostics: {},
        formatting: {},
        rangeFormatting: {},
        linkedEditingRange: {},
        completion: { completionItem: { snippetSupport: true, documentationFormat: ['markdown', 'plaintext'] } },
        codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ['quickfix', 'refactor', 'source'] } } },
      },
    },
    initializationOptions: { settings, extendedClientCapabilities: { classFileContentsSupport: true } },
  });
  notify('initialized', {});
  const readyTimer = globalThis.setTimeout(() => readyResolve(), 120000);
  await ready;
  globalThis.clearTimeout(readyTimer);
  report.initializeMs = Date.now() - t0;
  const caps = initialized.capabilities ?? {};
  report.linkedEditing.capability = caps.linkedEditingRangeProvider ?? null;
  console.log(`jdt.ls 就绪 ${report.initializeMs} ms；linkedEditingRangeProvider=${JSON.stringify(report.linkedEditing.capability)}`);

  const openAt = Date.now();
  notify('textDocument/didOpen', { textDocument: { uri: gapsUri, languageId: 'java', version: 1, text: GAPS } });
  const gapsDiags = await waitDiagnostics(gapsUri, 60000);
  report.diagnosticsLatency.gapsMs = Date.now() - openAt;
  report.suppressWarnings.diagnostics = gapsDiags.map((d) => ({
    severity: d.severity ?? 0,
    code: d.code ?? null,
    message: String(d.message).slice(0, 160),
    line: d.range?.start?.line ?? null,
  }));
  console.log(`Gaps 诊断 ${gapsDiags.length} 条，首次到达 ${report.diagnosticsLatency.gapsMs} ms`);

  // —— C1：诊断抑制 ——
  // 一条诊断一条诊断地问：jdt.ls 的 quick fix 是按问题类型给的，
  // 只问第一条会漏掉「unchecked / rawtypes 才有抑制建议」这种情况。
  const allTitles = [];
  const kinds = new Set();
  for (const diag of gapsDiags.slice(0, 8)) {
    const actions = await request('textDocument/codeAction', {
      textDocument: { uri: gapsUri },
      range: diag.range,
      context: { diagnostics: [diag] },
    }, 30000).catch(() => []);
    for (const action of Array.isArray(actions) ? actions : []) {
      kinds.add(action.kind ?? 'command');
      allTitles.push(String(action.title ?? ''));
    }
  }
  report.suppressWarnings.actionKinds = [...kinds];
  report.suppressWarnings.actionTitles = [...new Set(allTitles)];
  report.suppressWarnings.suppressTitles = [...new Set(allTitles.filter((t) => /suppress/i.test(t)))];
  report.suppressWarnings.found = report.suppressWarnings.suppressTitles.length > 0;
  console.log(`C1 逐条问 ${gapsDiags.length} 条诊断，聚合 ${allTitles.length} 个动作，kind=${[...kinds].join('/')}`);
  console.log(`   抑制类动作：${report.suppressWarnings.suppressTitles.join(' | ') || '无'}`);

  // —— C2：格式化 ——
  const formatOptions = { tabSize: 2, insertSpaces: true };
  const fullEdits = await request('textDocument/formatting', { textDocument: { uri: gapsUri }, options: formatOptions }, 30000);
  report.format.fullEdits = Array.isArray(fullEdits) ? fullEdits.length : 0;
  const fmtStart = lineAt('if(true)');
  const rangeEdits = await request('textDocument/rangeFormatting', {
    textDocument: { uri: gapsUri },
    range: { start: fmtStart, end: { line: fmtStart.line + 1, character: 0 } },
    options: formatOptions,
  }, 30000).catch((e) => { console.log(`C2 rangeFormatting 请求失败：${String(e).slice(0, 120)}`); return []; });
  report.format.rangeEdits = Array.isArray(rangeEdits) ? rangeEdits.length : 0;
  report.format.fullChanged = report.format.fullEdits > 0;
  console.log(`C2 formatting ${report.format.fullEdits} 处编辑，rangeFormatting ${report.format.rangeEdits} 处`);

  // —— C4：Linked Editing ——
  const linkedPos = lineAt('int gamma');
  try {
    const linked = await request('textDocument/linkedEditingRange', {
      textDocument: { uri: gapsUri },
      position: linkedPos,
    }, 20000);
    report.linkedEditing.requestOk = true;
    const ranges = linked?.ranges ?? linked ?? null;
    report.linkedEditing.ranges = Array.isArray(ranges) ? ranges.length : null;
    console.log(`C4 linkedEditingRange 返回 ${report.linkedEditing.ranges ?? 0} 段`);
  } catch (e) {
    console.log(`C4 linkedEditingRange 请求失败（服务端未实现）：${String(e).slice(0, 120)}`);
  }

  // —— A0：补全延迟（冷一次 + 热 19 次） ——
  const compPos = lineAt('return "x"');
  const compParams = { textDocument: { uri: gapsUri }, position: { line: compPos.line, character: 13 }, context: { triggerKind: 1 } };
  const samples = [];
  for (let i = 0; i < 20; i++) {
    const t = process.hrtime.bigint();
    await request('textDocument/completion', compParams, 30000);
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    if (i === 0) report.completion.coldMs = Math.round(ms);
    else samples.push(ms);
    await delay(20);
  }
  report.completion.samples = samples.length;
  report.completion.p50Ms = Math.round(median(samples));
  report.completion.minMs = Math.round(Math.min(...samples));
  report.completion.maxMs = Math.round(Math.max(...samples));
  console.log(`A0 补全冷 ${report.completion.coldMs} ms；热 p50 ${report.completion.p50Ms} ms（${report.completion.minMs}~${report.completion.maxMs}，n=${samples.length}）`);

  // —— A0：大文件 didOpen → 首次诊断 ——
  const bigText = readFileSync(bigFile, 'utf8');
  const bigStart = Date.now();
  notify('textDocument/didOpen', { textDocument: { uri: bigUri, languageId: 'java', version: 1, text: bigText } });
  await waitDiagnostics(bigUri, 120000);
  report.diagnosticsLatency.bigFileMs = Date.now() - bigStart;
  console.log(`A0 大文件 ${report.diagnosticsLatency.bigFileLines} 行：didOpen→首次诊断 ${report.diagnosticsLatency.bigFileMs} ms`);
  // 大文件里的补全都变慢才是 A4「降级」的真正依据：诊断慢只影响一次，补全慢影响每一次敲字
  const bigSamples = [];
  for (let i = 0; i < 5; i++) {
    const t = process.hrtime.bigint();
    await request('textDocument/completion', {
      textDocument: { uri: bigUri },
      position: { line: 5, character: 42 },
      context: { triggerKind: 1 },
    }, 60000).catch(() => null);
    bigSamples.push(Number(process.hrtime.bigint() - t) / 1e6);
    await delay(30);
  }
  report.diagnosticsLatency.bigFileCompletionP50Ms = Math.round(median(bigSamples));
  console.log(`A0 大文件补全 p50 ${report.diagnosticsLatency.bigFileCompletionP50Ms} ms（n=${bigSamples.length}）`);

  const out = join(base, 'editor-gaps.json');
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`\n结论已落盘：${out}`);
} catch (error) {
  console.error(error);
  console.error(stderr.slice(-4000));
  process.exitCode = 1;
} finally {
  try { await request('shutdown', null, 5000); notify('exit', null); } catch { child.kill(); }
  if (child.exitCode === null) await new Promise((r) => { const t = globalThis.setTimeout(() => { child.kill(); r(); }, 5000); child.once('exit', () => { globalThis.clearTimeout(t); r(); }); });
  for (const item of pending.values()) globalThis.clearTimeout(item.timer);
  assert.ok(fixture.startsWith(base + sep));
  rmSync(fixture, { recursive: true, force: true });
}
