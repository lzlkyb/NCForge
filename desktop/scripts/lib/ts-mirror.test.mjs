import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMirrors, renderBindings } from "./ts-mirror.mjs";

const parse = (text, file = "a.rs") => parseMirrors([{ file, text }]);

test("response 侧 Option<T> 生成 T | null", () => {
  const { structs, errors } = parse(`
// @ts-mirror response
pub struct Cfg {
    pub name: String,
    pub dir: Option<String>,
}
`);
  assert.deepEqual(errors, []);
  assert.deepEqual(structs[0].fields, [
    { name: "name", optional: false, type: "string", source: "name" },
    { name: "dir", optional: false, type: "string | null", source: "dir" },
  ]);
});

test("request 侧 Option<T> 生成可选字段，而不是 null", () => {
  const { structs } = parse(`
// @ts-mirror request
pub struct Patch {
    pub name: Option<String>,
    pub size: Option<u32>,
}
`);
  assert.deepEqual(structs[0].fields.map((f) => [f.name, f.optional, f.type]), [
    ["name", true, "string"],
    ["size", true, "number"],
  ]);
});

test("Vec / HashMap / 嵌套 Option 都能映射", () => {
  const { structs, errors } = parse(`
// @ts-mirror response
pub struct S {
    pub tags: Vec<String>,
    pub counts: HashMap<String, u32>,
    pub rows: Vec<Option<bool>>,
}
`);
  assert.deepEqual(errors, []);
  assert.deepEqual(structs[0].fields.map((f) => f.type), [
    "string[]",
    "Record<string, number>",
    // 必须带括号：`boolean | null[]` 在 TS 里读成「boolean 或 null 数组」
    "(boolean | null)[]",
  ]);
});

test("rename_all = camelCase 与字段级 rename 生效", () => {
  const { structs } = parse(`
// @ts-mirror response
#[derive(Debug)]
#[serde(rename_all = "camelCase")]
pub struct D {
    pub password_dpapi: Option<String>,
    #[serde(rename = "url")]
    pub jdbc_url: String,
}
`);
  assert.deepEqual(structs[0].fields.map((f) => f.name), ["passwordDpapi", "url"]);
});

test("前向引用：被引用的结构体定义在后面也能解析", () => {
  const { structs, errors } = parse(`
// @ts-mirror response
pub struct Outer {
    pub inner: Inner,
    pub list: Vec<Inner>,
}

// @ts-mirror response
pub struct Inner {
    pub id: String,
}
`);
  assert.deepEqual(errors, []);
  const outer = structs.find((s) => s.name === "Outer");
  assert.deepEqual(outer.fields.map((f) => f.type), ["Inner", "Inner[]"]);
});

test("没标记的结构体不镜像，但可以被标记的结构体引用", () => {
  const { structs } = parse(`
pub struct Ignored {
    pub a: String,
}

// @ts-mirror response
pub struct Kept {
    pub a: String,
}
`);
  assert.deepEqual(structs.map((s) => s.name), ["Kept"]);
});

test("未知类型报错，不生成猜出来的 any", () => {
  const { structs, errors } = parse(`
// @ts-mirror response
pub struct Bad {
    pub path: PathBuf,
}
`);
  assert.equal(structs[0].fields.length, 0);
  assert.match(errors[0], /未知类型 PathBuf/);
});

test("跨行字段与未闭合都报错", () => {
  const multiline = parse(`
// @ts-mirror response
pub struct Bad {
    pub a:
        String,
}
`);
  assert.match(multiline.errors[0], /字段看不懂/);

  const unterminated = parse(`
// @ts-mirror response
pub struct Bad {
    pub a: String,
`);
  assert.match(unterminated.errors[0], /没有闭合/);
});

test("#[serde(skip)] 的字段不进生成物", () => {
  const { structs } = parse(`
// @ts-mirror response
pub struct S {
    pub a: String,
    #[serde(skip)]
    pub hidden: String,
}
`);
  assert.deepEqual(structs[0].fields.map((f) => f.name), ["a"]);
});

test("同名结构体重复镜像算错（两个真源）", () => {
  const { errors } = parse(`
// @ts-mirror response
pub struct S {
    pub a: String,
}

// @ts-mirror response
pub struct S {
    pub b: String,
}
`);
  assert.ok(errors.some((e) => /重复镜像/.test(e)), errors.join("\n"));
});

test("标记写在非 struct 上不算数（避免以为生效了）", () => {
  const { structs } = parse(`
// @ts-mirror response
pub fn helper() -> u32 { 1 }

pub struct Later {
    pub a: String,
}
`);
  assert.deepEqual(structs, []);
});

test("同样的输入产出同样的字节（--check 靠文本比较）", () => {
  const src = `
// @ts-mirror response
pub struct B {
    pub y: Option<bool>,
}

// @ts-mirror request
pub struct A {
    pub x: Option<String>,
}
`;
  const once = renderBindings(parse(src).structs);
  const twice = renderBindings(parse(src).structs);
  assert.equal(once, twice);
  // 方向写在注释里，读生成物的人能看出这是入参还是出参
  assert.match(once, /request/);
  assert.match(once, /export interface A \{/);
  assert.match(once, /^ {2}x\?: string;$/m);
  assert.match(once, /^ {2}y: boolean \| null;$/m);
});
