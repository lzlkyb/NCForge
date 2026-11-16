import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { countJava, discoverProjects, isProjectDir, resolveRoot } from "./lang-index-root.mjs";

/** 造一个临时工作区，跑完即删（这些是探针自己的临时目录，不是用户工程）。 */
function withWorkspace(build, fn) {
  const dir = mkdtempSync(join(tmpdir(), "ncf-index-root-"));
  try {
    build(dir);
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const project = (dir, name) => {
  const p = join(dir, name);
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, ".project"), `<projectDescription><name>${name}</name></projectDescription>`);
  writeFileSync(join(p, ".classpath"), "<classpath/>");
  return p;
};

test("isProjectDir：有 .project 才算，文件/不存在都不算", () => {
  withWorkspace((dir) => {
    project(dir, "real");
    mkdirSync(join(dir, "plain"));
    writeFileSync(join(dir, "afile"), "x");
  }, (dir) => {
    assert.equal(isProjectDir(join(dir, "real")), true);
    assert.equal(isProjectDir(join(dir, "plain")), false);
    assert.equal(isProjectDir(join(dir, "afile")), false);
    assert.equal(isProjectDir(join(dir, "nope")), false);
  });
});

test("discoverProjects：root 下多个 IProject 全找出，按名排序", () => {
  withWorkspace((dir) => {
    project(dir, "phm");
    project(dir, "AppService");
    project(dir, "medPM");
    mkdirSync(join(dir, "not-a-project"));
  }, (dir) => {
    const found = discoverProjects(dir);
    assert.deepEqual(found.map((p) => p.split(/[\\/]/).pop()), ["AppService", "medPM", "phm"]);
  });
});

test("discoverProjects：root 自己就是 IProject 时返回 [root]", () => {
  withWorkspace((dir) => {
    writeFileSync(join(dir, ".project"), "<projectDescription/>");
  }, (dir) => {
    assert.deepEqual(discoverProjects(dir), [dir]);
  });
});

test("discoverProjects：不递归——bin 里的嵌套 .project 不算独立工程", () => {
  withWorkspace((dir) => {
    const p = project(dir, "phm");
    const nested = join(p, "bin");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, ".project"), "<projectDescription/>");
  }, (dir) => {
    const found = discoverProjects(dir);
    assert.equal(found.length, 1);
    assert.ok(found[0].endsWith("phm"));
  });
});

test("resolveRoot：不存在 / 是文件 / 无 IProject 都抛可读错误", () => {
  assert.throws(() => resolveRoot(""), /需要一个目录路径/);
  assert.throws(() => resolveRoot("Z:/definitely/not/here-xyz"), /不存在/);
  withWorkspace((dir) => {
    writeFileSync(join(dir, "f"), "x");
    assert.throws(() => resolveRoot(join(dir, "f")), /不是目录/);
    assert.throws(() => resolveRoot(dir), /没找到任何 IProject/);
  }, () => {});
});

test("resolveRoot：成功返回 root 与非空 projects", () => {
  withWorkspace((dir) => {
    project(dir, "a");
    project(dir, "b");
  }, (dir) => {
    const r = resolveRoot(dir);
    assert.equal(r.root, dir);
    assert.equal(r.projects.length, 2);
  });
});

test("countJava：数 java、排除 .svn / .git、大小写不敏感", () => {
  withWorkspace((dir) => {
    const p = project(dir, "m");
    const src = join(p, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "A.java"), "class A{}");
    writeFileSync(join(src, "B.JAVA"), "class B{}");
    writeFileSync(join(src, "notes.txt"), "x");
    const svn = join(p, ".svn");
    mkdirSync(svn, { recursive: true });
    writeFileSync(join(svn, "A.java.svn-base"), "x");
    writeFileSync(join(svn, "C.java"), "class C{}");
  }, (dir) => {
    assert.equal(countJava([join(dir, "m")]), 2);
  });
});