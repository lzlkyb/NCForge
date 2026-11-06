/**
 * 常驻 ecj 桥契约测试（真实 JVM，不依赖 NC 工程）。
 *
 * 跑法：node --test scripts/ecj-bridge-contract.test.mjs
 * 依赖：本机有 JDK（JAVA_HOME / NC_HOME/ufjdk / 常见安装位置 / PATH）；
 *       resources/ecj/ecj-3.17.jar 与 resources/ecj-bridge/ncecj.jar 存在
 *       （后者由 `node scripts/build-bridge-jar.mjs ecj` 生成）。
 *
 * 验的是协议与语义，不是编译器本身：
 * ① 同一进程连续多次编译都回响应，且 pid 不变（常驻成立）；
 * ② 有错 → exit=1 且输出带错误；无错 → exit=0；
 * ③ 响应里的 id 与请求一致（Rust 侧按 id 分发）；
 * ④ 堆不足回 code="oom"，不能伪装成「编译错误」（Rust 侧据此回退一次一进程）。
 */
import assert from 'node:assert/strict';
import { clearTimeout } from 'node:timers';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const ta = resolve(here, '..', 'src-tauri');
const ECJ = join(ta, 'resources', 'ecj', 'ecj-3.17.jar');
const BRIDGE = join(ta, 'resources', 'ecj-bridge', 'ncecj.jar');

function findJava() {
  if (process.env.JAVA_BIN && existsSync(process.env.JAVA_BIN)) return process.env.JAVA_BIN;
  const exe = process.platform === 'win32' ? 'java.exe' : 'java';
  // ecj-3.17 的 class 版本是 52：必须 Java 8+。本机 PATH/JAVA_HOME 可能指向
  // NC65 的 Java 7，所以先找 1909 这类自带 Java 8 的 NC home，最后才回退。
  const cands = [];
  for (const home of ['D:/ncc/1909home', 'C:/ncc/1909home', process.env.NC_HOME]) {
    if (home) cands.push(join(home, 'ufjdk', 'bin', exe));
  }
  if (process.env.JAVA_HOME) cands.push(join(process.env.JAVA_HOME, 'bin', exe));
  return cands.find((p) => existsSync(p)) ?? 'java';
}

/** 与 java_bridge.rs 的 escape 同一套：只转义 \t \n \r 与反斜杠。 */
const escape = (v) => v.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');

test('常驻 ecj 桥：复用 JVM、按 id 回包、错误语义正确', async () => {
  assert.ok(existsSync(ECJ), `缺 ${ECJ}`);
  assert.ok(existsSync(BRIDGE), `缺 ${BRIDGE}，先跑 node scripts/build-bridge-jar.mjs ecj`);

  const dir = mkdtempSync(join(tmpdir(), 'ncforge-ecj-bridge-'));
  const src = join(dir, 'src');
  const out = join(dir, 'out');
  mkdirSync(src);
  mkdirSync(out);
  const good = join(src, 'Good.java');
  const bad = join(src, 'Bad.java');
  writeFileSync(good, 'public class Good {\n  int value() { return 1; }\n}\n');
  writeFileSync(bad, 'public class Bad {\n  void run() { int a = ; }\n}\n');
  const argsFile = (file) => {
    const p = join(dir, `${file.replace('.java', '')}.args`);
    writeFileSync(
      p,
      `-1.8 -g -nowarn -proc:none -preserveAllLocals\n-d "${out.replace(/\\/g, '/')}"\n"${join(src, file).replace(/\\/g, '/')}"\n`,
    );
    return p;
  };
  const goodArgs = argsFile('Good.java');
  const badArgs = argsFile('Bad.java');

  const java = findJava();
  const child = spawn(java, ['-Dfile.encoding=UTF-8', '-Xmx1024m', '-cp', `${BRIDGE};${ECJ}`, 'NcEcjBridge', '--config', dir], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  const waiters = new Map();
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const w = waiters.get(msg.id);
      if (w) {
        waiters.delete(msg.id);
        w(msg);
      }
    }
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
  const request = (id, cmd, arg) =>
    new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error(`等 ${id} 超时；stderr=${stderr}`)), 30000);
      waiters.set(String(id), (msg) => {
        clearTimeout(timer);
        resolvePromise(msg);
      });
      child.stdin.write(`${id}\t${cmd}\t${escape(arg)}\n`);
    });

  try {
    const first = await request(1, 'compile', badArgs);
    assert.equal(first.id, '1', 'id 必须是字符串：java_bridge.rs 读线程按 as_str() 分发');
    assert.equal(first.ok, true);
    assert.equal(first.data.exit, 1, '带语法错误的文件应当 exit=1');
    assert.match(first.data.output, /error|错误/i, '输出里应有 ecj 的报错原文');

    const times = [];
    for (const [id, args, expect] of [
      [2, goodArgs, 0],
      [3, goodArgs, 0],
      [4, badArgs, 1],
      [5, goodArgs, 0],
    ]) {
      const t0 = performance.now();
      const r = await request(id, 'compile', args);
      times.push(Math.round(performance.now() - t0));
      assert.equal(r.id, String(id));
      assert.equal(r.data.exit, expect, `exit 不符：${r.data.output}`);
      assert.equal(r.data.pid, first.data.pid, '多次编译应当复用同一个 JVM');
    }
    assert.equal(child.exitCode, null, '桥进程在连续请求后仍应存活');

    // 堆不足：必须回 oom 帧，而不是把 OutOfMemoryError 当作编译错误塞进 output
    const huge = join(src, 'Huge.java');
    const methods = ['public class Huge {\n'];
    for (let i = 0; i < 150000; i++) methods.push(`  int m${i}() { return ${i}; }\n`);
    methods.push('}\n');
    writeFileSync(huge, methods.join(''));
    const hugeArgs = argsFile('Huge.java');
    const tight = spawn(
      java,
      ['-Xmx16m', '-Dfile.encoding=UTF-8', '-cp', `${BRIDGE};${ECJ}`, 'NcEcjBridge', '--config', dir],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    try {
      const oomMsg = await new Promise((resolvePromise, reject) => {
        let out = '';
        const timer = setTimeout(() => reject(new Error(`等 oom 帧超时；out=${out}`)), 30000);
        tight.stdout.on('data', (d) => {
          out += d.toString('utf8');
          if (!out.includes('\n')) return;
          clearTimeout(timer);
          resolvePromise(JSON.parse(out.slice(0, out.indexOf('\n'))));
        });
        tight.stderr.on('data', (d) => (out += d.toString('utf8')));
        tight.stdin.write(`1\tcompile\t${escape(hugeArgs)}\n`);
      });
      assert.equal(oomMsg.ok, false, '堆不足不能当成功');
      assert.equal(oomMsg.code, 'oom', `堆不足应回 oom 帧：${JSON.stringify(oomMsg)}`);
    } finally {
      tight.kill();
    }

    child.stdin.write('0\tquit\n');
    await new Promise((r) => child.once('exit', r));
    console.log(`连续编译耗时（ms）：${times.join(', ')}（首次含 JVM/JIT 预热）`);
  } catch (e) {
    child.kill();
    throw e;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
