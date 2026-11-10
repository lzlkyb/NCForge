import { expect, it } from "vitest";
import { callContext, hasOverloads, parameterLabel, pickOverload, signatureLabel, type CallContext } from "./sqlSignature";
import type { ProcOverload } from "./dbApi";

const at = (sql: string): CallContext | null => callContext(sql);

it("括号前的过程名与第几个参数", () => {
  expect(at("begin p_run(")).toEqual({ name: "p_run", argIndex: 0 });
  expect(at("begin p_run(a,")).toEqual({ name: "p_run", argIndex: 1 });
  expect(at("begin p_run(a, b ,")).toEqual({ name: "p_run", argIndex: 2 });
  // 包内过程：名字带点
  expect(at("begin nc_pkg.p_run(")).toEqual({ name: "nc_pkg.p_run", argIndex: 0 });
});

it("嵌套括号里的逗号不算参数分隔", () => {
  // 第二个参数是 nvl(x, y)，里面的逗号不算
  expect(at("select f(a, nvl(b, c),")).toEqual({ name: "f", argIndex: 2 });
  expect(at("select f(a, nvl(b, c)")).toEqual({ name: "f", argIndex: 1 });
});

it("字符串与注释里的括号、逗号不参与解析", () => {
  expect(at("call p('a,b', ")).toEqual({ name: "p", argIndex: 1 });
  expect(at("call p('it''s (x)', ")).toEqual({ name: "p", argIndex: 1 });
  expect(at("call p(a -- ),\n,")).toEqual({ name: "p", argIndex: 1 });
  expect(at("call p(a /* ) */,")).toEqual({ name: "p", argIndex: 1 });
});

it("不在调用里就不返回上下文", () => {
  expect(at("select 1 from dual")).toBeNull();
  // 括号已经闭合：光标不在参数列表里
  expect(at("call p(a) ")).toBeNull();
  // 关键字括号不是函数调用
  expect(at("select * from t where id in (")).toBeNull();
  expect(at("insert into t values (")).toBeNull();
  // 括号前没有标识符（子查询）
  expect(at("select * from (")).toBeNull();
});

const arg = (name: string, type = "VARCHAR2", defaulted = false) => ({ name, type, inOut: "IN", defaulted });

const ov = (args: ReturnType<typeof arg>[], extra: Partial<ProcOverload> = {}): ProcOverload => ({
  package: null,
  subprogramId: 1,
  returns: null,
  args,
  ...extra,
});

it("重载选择：优先参数个数够用的，同样够用时取最短的", () => {
  const short = ov([arg("a")], { subprogramId: 1 });
  const long = ov([arg("a"), arg("b")], { subprogramId: 2 });
  // 写第一个参数：两个都够用，取短的那个（长的那条默认参数是可选的）
  expect(pickOverload([long, short], 0)).toBe(short);
  // 写第二个参数：只有长的够用
  expect(pickOverload([short, long], 1)).toBe(long);
  // 参数写超了：没有够用的，退回参数最多的那个
  expect(pickOverload([short, long], 5)).toBe(long);
  expect(pickOverload([], 0)).toBeNull();
});

it("签名文本带包名、返回类型与默认值", () => {
  expect(signatureLabel("p_run", ov([arg("p_x", "NUMBER"), arg("p_y", "VARCHAR2", true)]))).toBe(
    "p_run(p_x NUMBER, p_y VARCHAR2 DEFAULT)",
  );
  // 函数：返回值单列
  expect(signatureLabel("f", ov([arg("n", "NUMBER")], { returns: "VARCHAR2" }))).toBe(
    "f(n NUMBER) RETURN VARCHAR2",
  );
  // 名字已经带包名时不再重复拼
  expect(signatureLabel("nc_pkg.p_run", ov([], { package: "NC_PKG" }))).toBe("nc_pkg.p_run()");
});

it("OUT 参数标出来，参数说明与签名一致", () => {
  const out = { name: "p_out", type: "NUMBER", inOut: "OUT", defaulted: false };
  expect(parameterLabel(out)).toBe("p_out OUT NUMBER");
  expect(signatureLabel("p", ov([out]))).toBe("p(p_out OUT NUMBER)");
});

it("空结果不算有重载", () => {
  expect(hasOverloads(null)).toBe(false);
  expect(hasOverloads({ name: "x", overloads: [] })).toBe(false);
  expect(hasOverloads({ name: "x", overloads: [ov([])] })).toBe(true);
});
