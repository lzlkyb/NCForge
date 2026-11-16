/**
 * 索引探针的「真实工程入口」纯函数 —— 方便单测。
 *
 * 为什么单独立一层：`lang-index-bench.mjs` 原本只会造一次性 fixture，量的是
 * 「合成工作副本」的索引耗时。但方案 A2 的目标（152 s → < 60 s）要拿**真实 NC
 * 工程**验证才有意义。加 `--root` 让探针指向真实工作区，同时必须守住一条红线：
 *
 *   🔴 对真实工程**只读**。jdt.ls 的 `-data` / config 一律写探针自己的临时目录，
 *      绝不往用户工程里落任何东西。所以这里只做「解析路径 + 发现 IProject」，
 *      不写盘、不造文件。
 *
 * 真实 NC 工作区的布局：root 下若干 IProject（每个带 `.project` + `.classpath`），
 * 也可能 root 自己就是一个 IProject。两种都要认。
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** 一个目录是不是 Eclipse IProject（`.project` 是判据，`.classpath` 佐证）。 */
export function isProjectDir(dir) {
  try {
    return statSync(dir).isDirectory() && existsSync(join(dir, ".project"));
  } catch {
    return false;
  }
}

/**
 * 发现工作区里的 IProject。
 *   · root 自己是 IProject → 返回 [root]；
 *   · 否则扫直接子目录，挑出带 `.project` 的（NC 工作区就是这种）；
 *   · 一个都没有 → 返回 []（调用方据此报错，别静默拿空索引冒充测过）。
 *
 * 只看直接子目录、不递归：NC 的 IProject 都在工作区根下一层，递归会误把
 * `bin/` 里的嵌套 `.project` 当成独立工程。
 */
export function discoverProjects(root) {
  if (!isProjectDir(root)) {
    let names;
    try {
      names = readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
    return names
      .filter((e) => e.isDirectory() && !e.isSymbolicLink())
      .map((e) => join(root, e.name))
      .filter(isProjectDir)
      .sort();
  }
  return [root];
}

/**
 * 解析并校验 `--root`。失败抛带可读信息的 Error（探针 catch 后退出码 1）。
 * 成功返回 `{ root, projects }`，projects 非空。
 */
export function resolveRoot(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("--root 需要一个目录路径");
  }
  const root = resolve(raw.trim());
  if (!existsSync(root)) {
    throw new Error(`--root 指的路径不存在：${root}`);
  }
  if (!statSync(root).isDirectory()) {
    throw new Error(`--root 不是目录：${root}`);
  }
  const projects = discoverProjects(root);
  if (projects.length === 0) {
    throw new Error(`--root 下没找到任何 IProject（缺 .project）：${root}`);
  }
  return { root, projects };
}

/** 数一组工程里的 java 源文件（排除 .svn）。只读，用来在报告里写明规模。 */
export function countJava(projects) {
  let total = 0;
  const walk = (dir) => {
    let names;
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) {
      if (e.name === ".svn" || e.name === ".git") continue;
      const p = join(dir, e.name);
      if (e.isDirectory() && !e.isSymbolicLink()) walk(p);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".java")) total += 1;
    }
  };
  for (const p of projects) walk(p);
  return total;
}