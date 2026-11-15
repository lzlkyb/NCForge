import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ search: vi.fn(), open: vi.fn(), navigate: vi.fn() }));
vi.mock("./typeSearch", () => ({ searchTypes: h.search, jarTypeUri: (hit: {jar:string}) => `nc-library://${hit.jar}` }));
vi.mock("./lang", () => ({ navigate: h.navigate }));
vi.mock("./openFileRequest", () => ({ requestOpenFile: h.open }));
import { findStackSources, openStackSource, stackLocation } from "./serviceLogSource";

beforeEach(() => vi.clearAllMocks());
describe("Java堆栈源码映射", () => {
  it("从Java8/模块前缀/内部类栈识别文件与真实行号", () => {
    expect(stackLocation("    at foo.Bar.run(Bar.java:42)")).toEqual({ className: "foo.Bar", file: "Bar.java", line: 42 });
    expect(stackLocation("    at java.base/java.util.ArrayList.get(ArrayList.java:427)")?.className).toBe("java.util.ArrayList");
    expect(stackLocation("    at foo.Bar$Inner.run(Bar.java:42)")?.className).toBe("foo.Bar");
    expect(stackLocation("    at foo.Bar.run(Native Method)")).toBeNull();
    expect(stackLocation("    at foo.Bar.run(Bar.java:0)")).toBeNull();
  });
  it("不按同名文件猜路径，精确匹配全限定类型与文件名", async () => {
    const location = stackLocation("at foo.Bar.run(Bar.java:42)")!;
    const hit = { name: "foo.Bar", file: "D:\\src\\foo\\Bar.java", module: "baseapp" };
    h.search.mockResolvedValue({ workspace: [hit, { name: "other.Bar", file: "D:\\src\\other\\Bar.java" }, { name: "foo.Bar", file: "D:\\src\\Wrong.java" }], jars: [] });
    expect(await findStackSources(location)).toEqual([hit]);
    openStackSource(hit as never, location); expect(h.open).toHaveBeenCalledWith({ path: hit.file, line: 42, column: 1 });
  });
  it("重复全限定类型保留候选交给用户选择", async () => {
    h.search.mockResolvedValue({ workspace: [{ name: "foo.Bar", file: "D:\\a\\Bar.java" }, { name: "foo.Bar", file: "D:\\b\\Bar.java" }] });
    expect(await findStackSources(stackLocation("at foo.Bar.run(Bar.java:42)")!)).toHaveLength(2); expect(h.open).not.toHaveBeenCalled();
  });
  it("保留JAR的准确来源并避免把原源码行号用于反编译文本", async () => {
    const location = stackLocation("at foo.Bar.run(Bar.java:42)")!;
    const hit = { name: "foo.Bar", file: "", jar: "D:/hyext/one.jar" };
    h.search.mockResolvedValue({ workspace: [], jars: [hit] });
    expect(await findStackSources(location)).toEqual([hit]);
    openStackSource(hit as never, location);
    await vi.waitFor(() => expect(h.navigate).toHaveBeenCalledWith({ kind: "jdt", uri: "nc-library://D:/hyext/one.jar", line: 1, column: 1 }));
    expect(h.open).not.toHaveBeenCalled();
  });
});
