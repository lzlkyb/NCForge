#!/usr/bin/env node
/**
 * 编译 Java 桥并打包成 resources 下的 jar。
 *
 * 仓库里的 ncdb.jar / ncsvn.jar 是构建产物，但一直靠手敲 javac 打的 —— 谁也不知道
 * 当初用了什么参数。改桥的源码后如果忘了重新打包，会出现「源码改了但行为没变」的假象，
 * 所以把这件事固化成脚本。
 *
 * 用法：
 *   node scripts/build-bridge-jar.mjs            # 两个桥都编
 *   node scripts/build-bridge-jar.mjs db         # 只编数据库桥
 *   node scripts/build-bridge-jar.mjs svn        # 只编 SVN 桥
 *   node scripts/build-bridge-jar.mjs db --dry   # 只编译到临时目录并报告，不覆盖 jar
 *
 * javac 的查找顺序：JAVA_HOME → NC_HOME/ufjdk → 几个常见 NC 安装位置 → PATH。
 * 桥代码按 Java 8 语法写（NC 自带的 ufjdk 就是 8），不要用 var / switch 表达式等新语法。
 */
import { existsSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ta = resolve(here, '..', 'src-tauri');

/** @type {Record<string, {src: string, out: string, cp: string[], label: string}>} */
const BRIDGES = {
  db: {
    src: join(ta, 'db-bridge', 'NcDbBridge.java'),
    out: join(ta, 'resources', 'ncdb', 'ncdb.jar'),
    // 数据库桥只依赖 JDK 标准库：Oracle 驱动与 NC 的 PropXMLReader 都是运行时才加载
    cp: [],
    label: 'NcDbBridge',
  },
  svn: {
    src: join(ta, 'svn-bridge', 'NcSvnBridge.java'),
    out: join(ta, 'resources', 'svnkit', 'ncsvn.jar'),
    // svnkit 及其依赖（antlr / trilead / sqljet）编桥时要在 classpath 上
    cp: ['antlr-runtime-3.1.3.jar', 'svnkit.jar', 'trilead.jar', 'sqljet.1.0.4.jar'].map((f) =>
      join(ta, 'resources', 'svnkit', f),
    ),
    label: 'NcSvnBridge',
  },
};

function findJdkTool(tool) {
  const exe = process.platform === 'win32' ? `${tool}.exe` : tool;
  const candidates = [];
  if (process.env.JAVA_HOME) candidates.push(join(process.env.JAVA_HOME, 'bin', exe));
  for (const home of [process.env.NC_HOME, 'D:/ncc/1909home', 'C:/ncc/1909home']) {
    if (home) candidates.push(join(home, 'ufjdk', 'bin', exe));
  }
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  // 退回 PATH
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const outText = execFileSync(which, [tool], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
    if (outText && existsSync(outText)) return outText;
  } catch {
    /* 下面统一报错 */
  }
  return null;
}

function run(exe, args) {
  const outText = execFileSync(exe, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return outText;
}

function buildOne(name, { dry }) {
  const spec = BRIDGES[name];
  if (!spec) throw new Error(`未知的桥：${name}（可选 ${Object.keys(BRIDGES).join(' / ')}）`);
  if (!existsSync(spec.src)) throw new Error(`源码不存在：${spec.src}`);

  const javac = findJdkTool('javac');
  const jar = findJdkTool('jar');
  if (!javac) {
    throw new Error(
      '找不到 javac。设 JAVA_HOME 指向一个 JDK，或设 NC_HOME 指向 NC 安装目录（里面有 ufjdk）。',
    );
  }

  const tmp = join(ta, '.bridge-build', name);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });

  const cp = spec.cp.filter((p) => {
    const ok = existsSync(p);
    if (!ok) console.warn(`  ! classpath 缺失，跳过：${p}`);
    return ok;
  });
  const javacArgs = ['-encoding', 'UTF-8', '-nowarn', '-d', tmp];
  if (cp.length) javacArgs.push('-cp', cp.join(process.platform === 'win32' ? ';' : ':'));
  javacArgs.push(spec.src);

  process.stdout.write(`编译 ${spec.label} … `);
  try {
    run(javac, javacArgs);
  } catch (e) {
    const msg = (e.stdout || '') + (e.stderr || '') || e.message;
    console.error('失败\n' + msg);
    process.exitCode = 1;
    return;
  }

  const classes = [];
  const walk = (dir, prefix) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p, prefix ? `${prefix}/${ent.name}` : ent.name);
      else if (ent.name.endsWith('.class')) {
        classes.push({ path: p, rel: prefix ? `${prefix}/${ent.name}` : ent.name });
      }
    }
  };
  walk(tmp, '');
  const bytes = classes.reduce((n, c) => n + statSync(c.path).size, 0);
  console.log(`完成（${classes.length} 个 class，共 ${(bytes / 1024).toFixed(1)} KB）`);

  if (dry) {
    console.log(`  --dry：保留在 ${tmp}，未覆盖 ${spec.out}`);
    return;
  }
  if (!jar) throw new Error('找不到 jar 工具，无法打包（设 JAVA_HOME 或 NC_HOME）');

  // jar 里不要带目录条目之外的杂物；用 -C 进临时目录，保证 entry 名是裸类名
  mkdirSync(dirname(spec.out), { recursive: true });
  run(jar, ['cf', spec.out, '-C', tmp, '.']);
  const size = statSync(spec.out).size;
  console.log(`打包 → ${spec.out}（${(size / 1024).toFixed(1)} KB）`);
  rmSync(tmp, { recursive: true, force: true });
}

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const names = args.filter((a) => !a.startsWith('--'));
const targets = names.length ? names : Object.keys(BRIDGES);
for (const n of targets) buildOne(n, { dry });
