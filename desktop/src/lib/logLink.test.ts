import { describe, expect, it } from "vitest";
import { parseLogLink } from "./logLink";

const ROOT = "D:\\newar";

describe("parseLogLink", () => {
  it("认 ecj 的绝对路径写法", () => {
    expect(parseLogLink("1. ERROR in D:\\newar\\pm\\src\\com\\x\\Foo.java (at line 42)", ROOT)).toEqual({
      path: "D:\\newar\\pm\\src\\com\\x\\Foo.java",
      line: 42,
    });
  });

  it("WARNING 也认（不是只有错误才值得点过去）", () => {
    const got = parseLogLink("3. WARNING in D:\\newar\\pm\\src\\A.java (at line 7)", ROOT);
    expect(got?.line).toBe(7);
  });

  it("相对路径按工作区根拼成绝对路径", () => {
    expect(parseLogLink("ERROR src\\com\\x\\Foo.java:12 类型 X 未定义", ROOT)).toEqual({
      path: "D:\\newar\\src\\com\\x\\Foo.java",
      line: 12,
    });
  });

  it("根为空时相对路径不认（拼出来也打不开）", () => {
    expect(parseLogLink("ERROR src\\Foo.java:12 出错了", "")).toBeNull();
  });

  it("没有行号的诊断行不当成链接", () => {
    expect(parseLogLink("诊断：工程 pm 有 3 个源文件比产物新", ROOT)).toBeNull();
    expect(parseLogLink("11 problems (10 errors, 1 warning)", ROOT)).toBeNull();
  });

  it("Java 堆栈不认（只有文件名，猜目录必然指错）", () => {
    expect(parseLogLink("\tat com.nc.Foo.bar(Foo.java:42)", ROOT)).toBeNull();
  });

  it("行号是 0 或负数时丢弃", () => {
    expect(parseLogLink("1. ERROR in D:\\a\\Foo.java (at line 0)", ROOT)).toBeNull();
  });
});
