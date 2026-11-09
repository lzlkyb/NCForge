/**
 * 热替换 agent 契约测试（真实 JVM，不依赖 NC）。
 *
 * 跑法：node --test scripts/hotswap-agent-contract.test.mjs
 * 依赖：本机有 Java 8 JDK（优先 NC 的 ufjdk，其次 JAVA_HOME / PATH）；
 *       resources/hotswap/ncforge-hotswap.jar 存在（由 `node scripts/build-bridge-jar.mjs hotswap` 生成）。
 *
 * 验的是 Rust 侧要依赖的协议与语义（方案 docs/NCForge-热替换-方案设计-2026-11-06.md §4.2）：
 * ① 启动后写出 .ready（端口 / pid / 协议版本），只绑 127.0.0.1；
 * ② 错令牌回 code=auth，协议头不对回 code=protocol；
 * ③ 方法体修改替换后立即生效；
 * ④ 加方法回 code=unsupported，且旧代码继续可用；
 * ⑤ 同名类来自别的目录 → shadowed，不替换；没加载过 → notLoaded；
 * ⑥ 文件不在 root 下或与类名不对应 → code=bad-request，整批不做。
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const AGENT = resolve(here, '..', 'src-tauri', 'resources', 'hotswap', 'ncforge-hotswap.jar');
const TOKEN = 'contract-token-0123456789abcdef';

function findJdk(tool) {
  const exe = process.platform === 'win32' ? `${tool}.exe` : tool;
  // 本机 JAVA_HOME 可能是 JDK 7：先找 NC 1909 自带的 ufjdk 1.8，与生产运行环境一致
  const cands = [];
  for (const home of ['D:/ncc/1909home', 'C:/ncc/1909home', process.env.NC_HOME]) {
    if (home) cands.push(join(home, 'ufjdk', 'bin', exe));
  }
  if (process.env.JAVA_HOME) cands.push(join(process.env.JAVA_HOME, 'bin', exe));
  return cands.find((p) => existsSync(p)) ?? tool;
}

const slash = (p) => p.replace(/\\/g, '/');

/** 发一个请求，收一行 JSON。 */
function request(port, lines) {
  return new Promise((resolvePromise, reject) => {
    const sock = connect({ host: '127.0.0.1', port });
    let buf = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`请求超时：${lines.join(' | ')}`));
    }, 15000);
    sock.on('data', (d) => (buf += d.toString('utf8')));
    sock.on('error', reject);
    sock.on('close', () => {
      clearTimeout(timer);
      try {
        resolvePromise(JSON.parse(buf.trim()));
      } catch {
        reject(new Error(`响应不是 JSON：${buf}`));
      }
    });
    sock.write(`${lines.join('\n')}\n`);
  });
}

const ping = (port, token = TOKEN) =>
  request(port, ['NCFORGE-HOTSWAP 1', `token ${token}`, 'op ping', 'end']);

const redefine = (port, roots, classes) =>
  request(port, [
    'NCFORGE-HOTSWAP 1',
    `token ${TOKEN}`,
    'op redefine',
    ...roots.map((r) => `root ${r}`),
    ...classes.map(([name, file]) => `class ${name}\t${file}`),
    'end',
  ]);

test('热替换 agent：鉴权、替换、结构性变更、遮蔽与路径校验', async () => {
  assert.ok(existsSync(AGENT), `缺 ${AGENT}，先跑 node scripts/build-bridge-jar.mjs hotswap`);
  const javac = findJdk('javac');
  const java = findJdk('java');

  const dir = mkdtempSync(join(tmpdir(), 'ncforge-hotswap-'));
  const src = (name) => join(dir, 'src', name);
  const classes = join(dir, 'classes'); // 工程产物目录：Target / Greeter 从这里加载
  const other = join(dir, 'other'); //     另一个目录：Shadow 从这里加载（模拟补丁 / NC home）
  const alt = join(dir, 'alt'); //         请求里声称的 Shadow / Lazy 产物目录
  for (const d of ['src', 'classes', 'other', 'alt', 'v2', 'v3']) mkdirSync(join(dir, d), { recursive: true });

  const sep = process.platform === 'win32' ? ';' : ':';
  const compile = (out, file, body, cp = []) => {
    writeFileSync(src(file), body);
    const cpArgs = cp.length ? ['-cp', cp.join(sep)] : [];
    execFileSync(javac, ['-nowarn', '-g', ...cpArgs, '-d', out, src(file)], { stdio: 'pipe' });
  };
  compile(classes, 'Greeter.java', 'public class Greeter { public static String value() { return "one"; } }\n');
  compile(other, 'Shadow.java', 'public class Shadow { public static String value() { return "other"; } }\n');
  // Target 引用 Greeter / Shadow：最后编，带上它们所在的目录
  compile(
    classes,
    'Target.java',
    `public class Target {
  public static void main(String[] a) throws Exception {
    java.io.BufferedReader r = new java.io.BufferedReader(new java.io.InputStreamReader(System.in));
    System.out.println("READY");
    String l;
    while ((l = r.readLine()) != null) {
      if (l.equals("g")) System.out.println("G=" + Greeter.value());
      else if (l.equals("s")) System.out.println("S=" + Shadow.value());
    }
  }
}
`,
    [classes, other],
  );
  compile(join(dir, 'v2'), 'Greeter.java', 'public class Greeter { public static String value() { return "two"; } }\n');
  compile(
    join(dir, 'v3'),
    'Greeter.java',
    'public class Greeter { public static String value() { return "three"; } public static int added() { return 3; } }\n',
  );
  compile(alt, 'Shadow.java', 'public class Shadow { public static String value() { return "alt"; } }\n');
  compile(alt, 'Lazy.java', 'public class Lazy { public static int n() { return 1; } }\n');

  const session = join(dir, 'session.properties');
  writeFileSync(session, `token=${TOKEN}\n`);
  const child = spawn(java, [`-javaagent:${AGENT}=${session}`, '-cp', `${classes}${sep}${other}`, 'Target'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d.toString('utf8')));
  child.stderr.on('data', (d) => (err += d.toString('utf8')));
  /** 发一条命令给 Target，等它打印以 prefix 开头的新行。 */
  const call = async (cmd, prefix) => {
    const before = out.length;
    child.stdin.write(`${cmd}\n`);
    for (let i = 0; i < 100; i++) {
      const line = out.slice(before).split(/\r?\n/).find((l) => l.startsWith(prefix));
      if (line) return line.slice(prefix.length);
      await sleep(50);
    }
    throw new Error(`Target 没有回应 ${cmd}；stdout=${out} stderr=${err}`);
  };

  try {
    // ① 就绪文件
    const readyFile = `${session}.ready`;
    for (let i = 0; i < 200 && !(existsSync(readyFile) && out.includes('READY')); i++) await sleep(50);
    assert.ok(existsSync(readyFile), `agent 没写出就绪文件；stderr=${err}`);
    const ready = Object.fromEntries(
      readFileSync(readyFile, 'utf8')
        .split(/\n/)
        .filter(Boolean)
        .map((l) => l.split('=')),
    );
    const port = Number(ready.port);
    assert.ok(port > 0, `就绪文件里没有端口：${JSON.stringify(ready)}`);
    assert.equal(ready.pid, String(child.pid), '就绪文件里的 pid 应是目标 JVM 的 pid');
    assert.equal(ready.protocol, '1');

    // ② 鉴权与协议头
    assert.equal((await ping(port, 'wrong-token-0123456789')).code, 'auth');
    assert.equal((await request(port, ['HELLO', 'end'])).code, 'protocol');
    const p = await ping(port);
    assert.equal(p.ok, true);
    assert.equal(p.pid, String(child.pid));
    assert.equal(p.canRedefine, true);

    // ③ 方法体修改：先让 Greeter 加载，再把 v2 覆盖到产物目录后替换
    assert.equal(await call('g', 'G='), 'one');
    copyFileSync(join(dir, 'v2', 'Greeter.class'), join(classes, 'Greeter.class'));
    const r2 = await redefine(port, [slash(classes)], [['Greeter', slash(join(classes, 'Greeter.class'))]]);
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.equal(r2.redefined.length, 1);
    assert.equal(r2.redefined[0].name, 'Greeter');
    assert.match(r2.redefined[0].loader, /AppClassLoader/);
    assert.equal(await call('g', 'G='), 'two', '替换后应立即走新代码');

    // ④ 加方法：整批不生效，旧代码照常
    copyFileSync(join(dir, 'v3', 'Greeter.class'), join(classes, 'Greeter.class'));
    const r3 = await redefine(port, [slash(classes)], [['Greeter', slash(join(classes, 'Greeter.class'))]]);
    assert.equal(r3.ok, false);
    assert.equal(r3.code, 'unsupported', JSON.stringify(r3));
    assert.match(r3.message, /add a method/);
    assert.equal(await call('g', 'G='), 'two', '结构性变更失败后旧代码应继续可用');

    // ⑤ 遮蔽与未加载：Shadow 实际来自 other，请求声称来自 alt
    assert.equal(await call('s', 'S='), 'other');
    const r4 = await redefine(
      port,
      [slash(alt)],
      [
        ['Shadow', slash(join(alt, 'Shadow.class'))],
        ['Lazy', slash(join(alt, 'Lazy.class'))],
      ],
    );
    assert.equal(r4.ok, true, JSON.stringify(r4));
    assert.equal(r4.redefined.length, 0);
    assert.deepEqual(r4.notLoaded, ['Lazy']);
    assert.equal(r4.shadowed.length, 1);
    assert.equal(r4.shadowed[0].name, 'Shadow');
    assert.equal(slash(r4.shadowed[0].source).toLowerCase(), slash(other).toLowerCase());
    assert.equal(await call('s', 'S='), 'other', '被遮蔽的类不应被替换');

    // ⑥ 路径校验：文件不在 root 下 / 类名与文件不对应，整批拒绝
    const outside = await redefine(port, [slash(classes)], [['Greeter', slash(join(dir, 'v2', 'Greeter.class'))]]);
    assert.equal(outside.code, 'bad-request', JSON.stringify(outside));
    const mismatch = await redefine(port, [slash(alt)], [['Greeter', slash(join(alt, 'Lazy.class'))]]);
    assert.equal(mismatch.code, 'bad-request', JSON.stringify(mismatch));
    assert.equal(await call('g', 'G='), 'two');
  } finally {
    child.kill();
    await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
    rmSync(dir, { recursive: true, force: true });
  }
});
