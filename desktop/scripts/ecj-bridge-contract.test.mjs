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
 * ④ 堆不足回 code="oom"，不能伪装成「编译错误」（Rust 侧据此回退一次一进程）；
 * ⑤ struct 指纹与 Eclipse 自己的 hasStructuralChanges（diff 命令当 oracle）逐项对齐：
 *    方法体/块内注解不变指纹，签名/常量（含 private）/注解成员值/增删成员变指纹；
 * ⑥ struct/diff 的单文件失败进 errors 不炸整批，读路径文件失败回 other 帧。
 */
import assert from 'node:assert/strict';
import { clearTimeout } from 'node:timers';
import { performance } from 'node:perf_hooks';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
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

test('struct 指纹与 Eclipse hasStructuralChanges 对齐；单文件失败不炸整批', async () => {
  assert.ok(existsSync(ECJ), `缺 ${ECJ}`);
  assert.ok(existsSync(BRIDGE), `缺 ${BRIDGE}，先跑 node scripts/build-bridge-jar.mjs ecj`);

  const dir = mkdtempSync(join(tmpdir(), 'ncforge-ecj-struct-'));
  const src = join(dir, 'src');
  mkdirSync(src);
  const java = findJava();
  const child = spawn(java, ['-Dfile.encoding=UTF-8', '-Xmx512m', '-cp', `${BRIDGE};${ECJ}`, 'NcEcjBridge', '--config', dir], {
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
  let seq = 0;
  const request = (cmd, arg) =>
    new Promise((resolvePromise, reject) => {
      const id = String(++seq);
      const timer = setTimeout(() => reject(new Error(`等 ${id}(${cmd}) 超时；stderr=${stderr}`)), 30000);
      waiters.set(id, (msg) => {
        clearTimeout(timer);
        resolvePromise(msg);
      });
      child.stdin.write(`${id}\t${cmd}\t${escape(arg)}\n`);
    });
  const fwd = (p) => p.replace(/\\/g, '/');

  // 编译一份源到指定输出目录（走桥的 compile 命令，与真实链路同一条路）
  const compileTo = async (files, outDir) => {
    mkdirSync(outDir, { recursive: true });
    const args = join(dir, `c${seq}.args`);
    writeFileSync(args, `-1.8 -g -nowarn -proc:none -preserveAllLocals\n-d "${fwd(outDir)}"\n${files.map((f) => `"${fwd(f)}"\n`).join('')}`);
    const r = await request('compile', args);
    assert.equal(r.ok, true, `compile 帧应 ok：${JSON.stringify(r)}`);
    assert.equal(r.data.exit, 0, `编译应无错：${r.data.output}`);
    return r;
  };
  const structOf = async (classFiles) => {
    const paths = join(dir, `s${seq}.paths`);
    writeFileSync(paths, classFiles.map(fwd).join('\n') + '\n');
    const r = await request('struct', paths);
    assert.equal(r.ok, true, `struct 帧应 ok：${JSON.stringify(r)}`);
    const byBase = {};
    for (const s of r.data.structs) byBase[s.path.split('/').pop()] = s.fp;
    return { byBase, errors: r.data.errors, pid: r.data.pid };
  };
  const diffOf = async (pairs) => {
    const pf = join(dir, `d${seq}.pairs`);
    writeFileSync(pf, pairs.map(([a, b]) => `${fwd(a)}\t${fwd(b)}`).join('\n') + '\n');
    const r = await request('diff', pf);
    assert.equal(r.ok, true, `diff 帧应 ok：${JSON.stringify(r)}`);
    const byBase = {};
    for (const d of r.data.diffs) byBase[d.old.split('/').pop()] = d.structural;
    return { byBase, errors: r.data.errors };
  };

  const anno = join(src, 'Mark.java');
  writeFileSync(anno, 'package p;\nimport java.lang.annotation.*;\n@Retention(RetentionPolicy.RUNTIME)\npublic @interface Mark { String value(); }\n');
  const base = join(src, 'Base.java');
  const original = [
    'package p;',
    '@Mark("a")',
    'public class Base {',
    '  public static final String S = "a";',
    '  public static final int N = 1;',
    '  private static final String PS = "x";',
    '  public int field;',
    '  private int priv;',
    '  public void m(int x) throws java.io.IOException { int local = 1; }',
    '  private void helper() {}',
    '  public static class Inner { public void im() {} }',
    '}',
    '',
  ].join('\n');
  writeFileSync(base, original);

  try {
    const out0 = join(dir, 'out0');
    const first = await compileTo([anno, base], out0);
    const classes = (out) => [join(out, 'p', 'Base.class'), join(out, 'p', 'Base$Inner.class')];
    const fp0 = await structOf(classes(out0));
    assert.ok(fp0.byBase['Base.class'], 'Base 应有指纹');
    assert.ok(fp0.byBase['Base$Inner.class'], 'Inner 应有指纹');
    assert.deepEqual(fp0.errors, [], '正常批不应有 errors');

    // 每个变体：改源码 → 编到新目录 → struct 指纹差 ⟺ diff oracle 判结构变化。
    // expected 按 Eclipse hasStructuralChanges 的语义写（private 成员不豁免、注解成员值算、
    // 方法体不算）。先跑 oracle 再断言指纹，两边不一致就是指纹投影漏了东西。
    const variants = [
      ['只改方法体', original.replace('int local = 1;', 'int local = 2;'), false, false],
      ['改 String 常量', original.replace('String S = "a";', 'String S = "b";'), true, null],
      ['改 int 常量', original.replace('int N = 1;', 'int N = 2;'), true, null],
      ['改 private 常量', original.replace('String PS = "x";', 'String PS = "y";'), true, null],
      ['改 public 方法签名', original.replace('void m(int x)', 'void m(String x)'), true, null],
      ['加 private 方法', original.replace('private void helper() {}', 'private void helper() {}\n  private void extra() {}'), true, null],
      ['加 private 字段', original.replace('private int priv;', 'private int priv;\n  private int priv2;'), true, null],
      ['加类注解', original.replace('@Mark("a")', '@Deprecated\n@Mark("a")'), true, null],
      ['改注解成员值', original.replace('@Mark("a")', '@Mark("b")'), true, null],
      ['改内部类方法签名', original.replace('public void im() {}', 'public void im(int x) {}'), false, true],
    ];
    for (const [name, text, expectBase, expectInner] of variants) {
      writeFileSync(base, text);
      const outN = join(dir, `out_${seq}`);
      await compileTo([anno, base], outN);
      const fpN = await structOf(classes(outN));
      const oracle = await diffOf(classes(out0).map((c, i) => [c, classes(outN)[i]]));
      assert.deepEqual(oracle.errors, [], `${name}: oracle 不应有 errors`);
      for (const cls of ['Base.class', 'Base$Inner.class']) {
        const structural = oracle.byBase[cls];
        const fpChanged = fp0.byBase[cls] !== fpN.byBase[cls];
        assert.equal(fpChanged, structural, `${name} / ${cls}: 指纹变化(${fpChanged})必须与 Eclipse 结构判定(${structural})一致`);
      }
      if (expectBase !== null) {
        assert.equal(oracle.byBase['Base.class'], expectBase, `${name}: Base 结构判定不符 Eclipse 语义`);
      }
      if (expectInner !== null) {
        assert.equal(oracle.byBase['Base$Inner.class'], expectInner, `${name}: Inner 结构判定不符 Eclipse 语义`);
      }
    }

    // 单文件失败进 errors，不炸整批；缺路径文件回 other 帧
    const missing = join(dir, 'no-such.class');
    const bad = await structOf([classes(out0)[0], missing]);
    assert.ok(bad.byBase['Base.class'], '坏文件不应影响好文件的指纹');
    assert.equal(bad.errors.length, 1, '坏文件应进 errors');
    assert.ok(bad.errors[0].includes('no-such.class'), 'errors 应带路径');
    const noFile = await request('struct', join(dir, 'absent.paths'));
    assert.equal(noFile.ok, false);
    assert.equal(noFile.code, 'other');

    // struct/diff 与 compile 复用同一个 JVM
    assert.equal(fp0.pid, first.data.pid, 'struct 应与 compile 复用同一 JVM');
    const again = await compileTo([anno, base], join(dir, 'out_again'));
    assert.equal(again.data.pid, first.data.pid, 'struct/diff 之后 compile 仍复用同一 JVM');
    child.stdin.write('0\tquit\n');
    await new Promise((r) => child.once('exit', r));
  } catch (e) {
    child.kill();
    throw e;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * ⑦ Phase 1 索引器与桥**同一个 jar**，但它是独立 main（`java -cp ncecj.jar NcIndexer …`）。
 *
 * 这条防两件事：Java 改了忘记 `build-bridge-jar.mjs ecj`（jar 里没有新类）；
 * 以及写出的 `types.idx` 头部与 `src/decl_index.rs` 的读取器漂移 —— 后者用单测钉格式，
 * 这里钉的是「真的能从一个最小工作区产出来、且整份记录区都解得通」。
 */
test('索引器 NcIndexer：独立入口能建出格式正确的 types.idx', () => {
  assert.ok(existsSync(BRIDGE), `缺 ${BRIDGE}，先跑 node scripts/build-bridge-jar.mjs ecj`);

  const dir = mkdtempSync(join(tmpdir(), 'ncforge-decl-idx-'));
  try {
    // 一个模块 / 一个源根 / 两个类：够验「能发现模块、能 parse、头部计数正确」
    const pkg = join(dir, 'mod', 'src', 'private', 'demo');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'A.java'), 'package demo;\npublic class A {\n  int f;\n  void m(int x) {}\n}\n');
    writeFileSync(join(pkg, 'B.java'), 'package demo;\npublic class B extends A {\n}\n');

    const out = join(dir, 't.idx');
    // Java 的 -cp 用 ';' 分隔，路径统一成正斜杠（避免 Windows 反斜杠与通配符混用）
    const norm = (p) => p.split(sep).join('/');
    const cp = `${norm(BRIDGE)};${norm(join(ta, 'resources', 'jdtls', 'plugins'))}/*`;
    const r = spawnSync(
      findJava(),
      ['-Dfile.encoding=UTF-8', '-cp', cp, '-Xmx512m', 'NcIndexer', '--ws', dir, '--out', out, '--threads', '1'],
      { encoding: 'utf8' },
    );
    const log = `${r.stdout || ''}${r.stderr || ''}`;
    // 类不在 jar 里时，JVM 报的是 ClassNotFoundException —— 这条断言就是「忘了重新打包」的探针
    assert.ok(!/ClassNotFound/.test(log), `jar 里没有 NcIndexer，先跑 build-bridge-jar.mjs ecj\n${log}`);
    assert.equal(r.status, 0, `NcIndexer 退出码 ${r.status}\n${log}`);
    assert.ok(/源文件 2 个/.test(log), `应发现 2 个源文件\n${log}`);

    const buf = readFileSync(out);
    assert.equal(buf.subarray(0, 8).toString('latin1'), 'NCFIDX01', '魔数必须与 decl_index.rs 一致');
    assert.equal(buf.readInt32BE(8), 3, '格式版本（v3 = 成员带声明行）');
    assert.equal(buf.readInt32BE(12), 2, '类型数（A + B）');
    assert.equal(buf.readInt32BE(16), 2, '路径数（A.java + B.java 各一条）');
    // 头部末尾是落盘时刻：判「索引过期」全靠它，所以必须在、且是个像样的毫秒时间戳。
    // 少了它 Rust 侧 `read_stats` 会读到记录区前 8 字节，判据就变成随机数。
    const builtAt = Number(buf.readBigInt64BE(40));
    assert.ok(
      builtAt > 1_600_000_000_000 && builtAt < Date.now() + 60_000,
      `builtAtMs 不像当前时间戳：${builtAt}`,
    );

    // 记录区整体解一遍：只钉头部挡不住「字段写了一半」这类错位，
    // 而 Rust 侧读到成员行号错位的索引不会报错，只会**跳到错的行**。
    const types = parseIdx(buf);
    assert.equal(types.length, 2, '记录数应与头部一致');
    const a = types.find((t) => t.name === 'demo.A');
    assert.ok(a, `应能按全限定名找到 demo.A：${types.map((t) => t.name)}`);
    assert.equal(a.line, 2, 'A 的 class 声明行');
    assert.deepEqual(
      a.methods.map((m) => [m.sig, m.line]),
      [['m(int)', 4]],
      '方法签名与声明行（`void m(int x) {}` 在第 4 行）',
    );
    assert.deepEqual(
      a.fields.map((f) => [f.sig, f.line]),
      [['f:int', 3]],
      '字段名、类型与声明行',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * ⑧ 常驻 binding resolver（窗口期精确跳转的第二链路）与桥**同一个 jar**，独立 main
 * （`java -cp ncecj.jar;ecj-3.17.jar BindingResolver`，行协议照 NcEcjBridge）。
 *
 * 防三件事：Java 改了忘记 `build-bridge-jar.mjs ecj`（jar 里没有新类，探针 = ClassNotFound）；
 * 行协议与 `src/bind_resolver/args.rs` 的写入侧漂移（id 字符串、init/resolve/invalidate 帧）；
 * 以及身份语义——Java 只回 kind+fqcn+name，位置由 Rust 查 decl_index，这里钉住
 * 「点号成员判 method、类型引用判 type、空白处回 null」三类 offset 的归属。
 * 其中 `a.value()` 点 value 必须回 method/demo.A/value 而不是 local/a：QualifiedNameReference
 * 逐 token 归属（sourcePositions + indexOfFirstFieldBinding + otherBindings）的回归探针
 * （2026-11-21 合成冒烟抓到过，见 BindingResolver.java 文件头坑 6）。
 */
test('BindingResolver：init/resolve 协议与身份语义', async () => {
  assert.ok(existsSync(BRIDGE), `缺 ${BRIDGE}，先跑 node scripts/build-bridge-jar.mjs ecj`);

  const dir = mkdtempSync(join(tmpdir(), 'ncforge-binding-'));
  const src = join(dir, 'src');
  const pkg = join(src, 'demo');
  mkdirSync(pkg, { recursive: true });
  // 两个类：A 是被引用的类型；B 里同时踩「点号成员」「类型引用」「语句间空白」三种 offset
  const a = 'package demo;\npublic class A {\n  public int value() { return 1; }\n}\n';
  const b = 'package demo;\npublic class B {\n  void run(A a) { a.value(); }\n}\n';
  writeFileSync(join(pkg, 'A.java'), a);
  writeFileSync(join(pkg, 'B.java'), b);

  const norm = (p) => p.split(sep).join('/');
  const java = findJava();
  const child = spawn(java, ['-Dfile.encoding=UTF-8', '-Xmx512m', '-cp', `${norm(BRIDGE)};${norm(ECJ)}`, 'BindingResolver'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  let stderr = '';
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
  child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
  const request = (id, cmd, arg) =>
    new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error(`等 ${id} 超时；stderr=${stderr}`)), 60000);
      waiters.set(String(id), (msg) => {
        clearTimeout(timer);
        resolvePromise(msg);
      });
      child.stdin.write(`${id}\t${cmd}\t${escape(arg)}\n`);
    });
  const argsFile = (name, text) => {
    const p = join(dir, name);
    writeFileSync(p, text);
    return norm(p);
  };
  const bPath = norm(join(pkg, 'B.java'));

  try {
    // ① 尚未 init 要先答 error/other：Rust 侧把非 ok 当失败计数，不能静默回 null 冒充「没有引用」
    const early = await request(1, 'resolve', argsFile('early.json', JSON.stringify({ path: bPath, offset: 0 })));
    assert.equal(early.id, '1', 'id 必须是字符串：java_bridge.rs 读线程按 as_str() 分发');
    assert.equal(early.ok, false);
    assert.equal(early.code, 'other');
    assert.match(early.error, /尚未 init/);

    // ② init：classpath 一行一个源根（源根必须在目录条目里——包名按最长目录前缀推导）；
    //    data 回条目数与 rt.jar 是否找到（Java 9+ 布局没有 rt.jar，绑定退化但不炸）
    const init = await request(2, 'init', argsFile('cp.txt', `${norm(src)}\n`));
    assert.equal(init.ok, true);
    assert.equal(init.data.entries, 1, '一个源根');
    assert.equal(init.data.dirs, 1, '源根是目录条目');
    assert.equal(typeof init.data.rtJar, 'boolean');
    if (!init.data.rtJar) console.warn('未找到 rt.jar（Java 9+ 布局）：java.lang 绑定会退化，本机建议用 Java 8');

    // ③ offset 口径 = UTF-16 code unit（纯 ASCII 下与 indexOf 相同）；
    //    `a.value()` 的 value 必须回 method/demo.A/value——逐 token 归属的回归探针
    const vOff = b.indexOf('a.value()') + 2;
    assert.equal(b.slice(vOff, vOff + 5), 'value', 'offset 应落在 value 上');
    const mv = await request(3, 'resolve', argsFile('mv.json', JSON.stringify({ path: bPath, offset: vOff })));
    assert.equal(mv.ok, true);
    assert.equal(mv.data.kind, 'method', `点号成员应判成方法：${JSON.stringify(mv.data)}`);
    assert.equal(mv.data.fqcn, 'demo.A');
    assert.equal(mv.data.name, 'value');

    // ④ 类型引用 → type，name 取简单名
    const tOff = b.indexOf('void run(A a)') + 'void run('.length;
    assert.equal(b.slice(tOff, tOff + 1), 'A', 'offset 应落在类型 A 上');
    const tv = await request(4, 'resolve', argsFile('tv.json', JSON.stringify({ path: bPath, offset: tOff })));
    assert.equal(tv.ok, true);
    assert.equal(tv.data.kind, 'type', `类型引用应判成 type：${JSON.stringify(tv.data)}`);
    assert.equal(tv.data.fqcn, 'demo.A');
    assert.equal(tv.data.name, 'A');

    // ⑤ 同一进程缓存命中：再来一次必须同一答案（CU 缓存不改变语义）
    const again = await request(5, 'resolve', argsFile('mv2.json', JSON.stringify({ path: bPath, offset: vOff })));
    assert.equal(again.ok, true);
    assert.equal(again.data.kind, 'method');
    assert.equal(again.data.fqcn, 'demo.A');

    // ⑥ 语句间空白没有可解析引用 → data 为 null（Rust 侧据此退回内容搜索，不当成错误）
    const blankOff = b.indexOf('{ a.value()') + 1;
    assert.equal(b.slice(blankOff, blankOff + 1), ' ', 'offset 应落在 { 后的空格上');
    const nv = await request(6, 'resolve', argsFile('nv.json', JSON.stringify({ path: bPath, offset: blankOff })));
    assert.equal(nv.ok, true);
    assert.equal(nv.data, null, `空白处应回 null：${JSON.stringify(nv.data)}`);

    // ⑦ invalidate 整体作废 CU 缓存，之后查询仍须自愈（reset 不破坏引擎）
    const inv = await request(7, 'invalidate', argsFile('inv.txt', `${bPath}\n`));
    assert.equal(inv.ok, true);
    assert.equal(inv.data.paths, 1);
    assert.ok(inv.data.cachedCleared >= 1, 'B.java 已解析过，缓存里应有它');
    const healed = await request(8, 'resolve', argsFile('mv3.json', JSON.stringify({ path: bPath, offset: vOff })));
    assert.equal(healed.ok, true);
    assert.equal(healed.data.kind, 'method');
    assert.equal(healed.data.fqcn, 'demo.A');

    // ⑧ 未知命令 → other（Rust 侧按 code 分桶计数，不能炸进程）
    const unk = await request(9, 'frobnicate', argsFile('x.txt', 'x\n'));
    assert.equal(unk.ok, false);
    assert.equal(unk.code, 'other');

    child.stdin.write('10\tquit\n');
    await new Promise((r) => child.once('exit', r));
  } catch (e) {
    child.kill();
    throw e;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 把 `types.idx` 整体解成对象。**与 `src/decl_index.rs::parse_with` 逐字段对应**：
 * 两边任何一侧改了写法，这条测试都会红（这是它存在的唯一理由）。
 */
function parseIdx(buf) {
  const typeCount = buf.readInt32BE(12);
  const pathCount = buf.readInt32BE(16);
  let p = 48; // 头部定长，见 decl_index.rs::HEADER_LEN
  const str = () => {
    const n = buf.readUInt16BE(p);
    p += 2;
    const s = buf.toString('utf8', p, p + n);
    p += n;
    return s;
  };
  const i32 = () => {
    const v = buf.readInt32BE(p);
    p += 4;
    return v;
  };
  const paths = [];
  for (let i = 0; i < pathCount; i++) paths.push(str());
  const out = [];
  for (let i = 0; i < typeCount; i++) {
    const kind = buf[p++];
    const fromJar = buf[p++] !== 0;
    const pathIdx = i32();
    const line = i32();
    const name = str();
    const members = (n) =>
      Array.from({ length: n }, () => {
        const sig = str();
        return { sig, line: i32() };
      });
    const methods = members(i32());
    const fields = members(i32());
    out.push({ kind, fromJar, path: paths[pathIdx], line, name, methods, fields });
  }
  assert.equal(p, buf.length, '解析长度与文件长度不符：记录区写法与读取端不一致');
  return out;
}
