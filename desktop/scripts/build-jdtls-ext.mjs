#!/usr/bin/env node
/**
 * 编译 jdt.ls 扩展 bundle 并打包成 resources 下的 jar。
 *
 * 这个扩展只做一件事：在 jdt.ls 进程内实现 `ncforge.typeHierarchy`（0.57 没有
 * LSP 的 TypeHierarchy）。它靠 `initializationOptions.bundles` 挂进 OSGi，
 * 因此必须是带 MANIFEST.MF 与 plugin.xml 的合法 bundle —— 不能像普通 jar 那样只装 class。
 *
 * 用法：
 *   node scripts/build-jdtls-ext.mjs           # 编译并覆盖 resources/jdtls-ext/ncforge-jdt-ext.jar
 *   node scripts/build-jdtls-ext.mjs --dry     # 只编译到临时目录并报告
 *
 * 编译要先有 jdt.ls 的 jars（`node scripts/fetch-jdtls.mjs`）。产物很小（约 10KB），
 * 跟 ncdb.jar 一样直接入库；改了 Java 源码忘了重打包会出现「源码改了行为没变」。
 *
 * 代码按 Java 8 写（jdt.ls 0.57 的 Bundle-RequiredExecutionEnvironment 就是 1.8）。
 */
import { existsSync, mkdirSync, rmSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ta = resolve(here, '..', 'src-tauri');
const ext = join(ta, 'jdtls-ext');
const lsDir = process.env.NCFORGE_JDTLS_DIR
  ? resolve(process.env.NCFORGE_JDTLS_DIR)
  : join(ta, 'resources', 'jdtls');
const out = join(ta, 'resources', 'jdtls-ext', 'ncforge-jdt-ext.jar');
const dry = process.argv.includes('--dry');

function majorOf(javacExe) {
  // `javac -version` 在 JDK 7 写 stderr、在 8+ 写 stdout，两边都要看
  const r = spawnSync(javacExe, ['-version'], { encoding: 'utf8' });
  const m = /\b(\d+)\.(\d+)/.exec(`${r.stdout ?? ''}${r.stderr ?? ''}`);
  if (!m) return 0;
  return Number(m[1]) === 1 ? Number(m[2]) : Number(m[1]);
}

/**
 * 找 javac / jar。不能只认 JAVA_HOME：这台机器的 JAVA_HOME 指向 NC65 自带的 JDK 7，
 * 而 jdt.ls 的 class 是 Java 8 字节码（javac 7 读不了），所以优先挑 ≥8 的那个。
 */
function findJdkTool(tool) {
  const exe = process.platform === 'win32' ? `${tool}.exe` : tool;
  const dirs = [];
  for (const home of [
    process.env.NCFORGE_JAVA_HOME,
    process.env.JAVA_HOME,
    process.env.NC_HOME && join(process.env.NC_HOME, 'ufjdk'),
    'D:/ncc/1909home/ufjdk',
    'C:/ncc/1909home/ufjdk',
  ]) {
    if (home) dirs.push(join(home, 'bin'));
  }
  const candidates = dirs.map((d) => join(d, exe)).filter((p) => existsSync(p));
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const found = execFileSync(which, [tool], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
    if (found && existsSync(found)) candidates.push(found);
  } catch {
    /* 下面统一报错 */
  }
  // javac 要 ≥8；jar 跟着同一个 JDK 走，版本检查只对 javac 有意义
  if (tool === 'javac') {
    const ok = candidates.find((p) => majorOf(p) >= 8);
    if (ok) return ok;
    return candidates[0] ?? null;
  }
  const javac = findJdkTool('javac');
  if (javac) {
    const sibling = join(dirname(javac), exe);
    if (existsSync(sibling)) return sibling;
  }
  return candidates[0] ?? null;
}

const plugins = join(lsDir, 'plugins');
if (!existsSync(plugins)) {
  console.error(`找不到 jdt.ls 的 plugins 目录：${plugins}`);
  console.error('先跑 `node scripts/fetch-jdtls.mjs`，或用 NCFORGE_JDTLS_DIR 指向已裁剪的 jdt.ls。');
  process.exit(1);
}

const javac = findJdkTool('javac');
const jar = findJdkTool('jar');
if (!javac || !jar) {
  console.error('找不到 javac / jar。设 JAVA_HOME 指向一个 JDK，或设 NC_HOME 指向 NC 安装目录（里面有 ufjdk）。');
  process.exit(1);
}

const sources = [];
const walk = (dir) => {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walk(p);
    else if (ent.name.endsWith('.java')) sources.push(p);
  }
};
walk(join(ext, 'src'));
if (sources.length === 0) {
  console.error(`源码目录里没有 .java：${join(ext, 'src')}`);
  process.exit(1);
}

const cp = readdirSync(plugins)
  .filter((f) => f.endsWith('.jar'))
  .map((f) => join(plugins, f));
const tmp = join(ta, '.jdtls-ext-build');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

console.log(`编译扩展（${sources.length} 个源文件，classpath ${cp.length} 个 jar）…`);
try {
  execFileSync(
    javac,
    ['-encoding', 'UTF-8', '-nowarn', '-source', '1.8', '-target', '1.8', '-cp', cp.join(process.platform === 'win32' ? ';' : ':'), '-d', tmp, ...sources],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
} catch (e) {
  console.error('编译失败\n' + ((e.stdout || '') + (e.stderr || '') || e.message));
  process.exit(1);
}

copyFileSync(join(ext, 'plugin.xml'), join(tmp, 'plugin.xml'));

if (dry) {
  console.log(`--dry：class 与 plugin.xml 保留在 ${tmp}，未打包`);
} else {
  mkdirSync(dirname(out), { recursive: true });
  execFileSync(jar, ['cfm', out, join(ext, 'MANIFEST.MF'), '-C', tmp, '.'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const size = statSync(out).size;
  console.log(`打包 → ${out}（${(size / 1024).toFixed(1)} KB）`);
  rmSync(tmp, { recursive: true, force: true });
}
