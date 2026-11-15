import { describe, expect, it, vi } from "vitest";
vi.mock("./tauri", () => ({ invoke: vi.fn() }));
import { libraryLocation, libraryUri, parseLibraryUri, libraryTabMeta, sameLibrarySource } from "./libraryFiles";
import { jarTypeUri } from "./typeSearch";
describe("库文件地址", () => {
  it("同名 JAR 保留准确来源及特殊字符", () => {
    const a = { source: "D:/NC/modules/pp/hyext/lib/同名 #1.jar", entry: "nc/ui/消息 #1.properties", archive: true };
    const b = { ...a, source: "D:/NC/modules/other/lib/同名 #1.jar" };
    expect(libraryUri(a)).not.toBe(libraryUri(b)); expect(parseLibraryUri(libraryUri(a))).toEqual(a);
    expect(libraryLocation(libraryUri(a))).toBe(`${a.source} ! ${a.entry}`);
    expect(parseLibraryUri(jarTypeUri({ jar: a.source, name: "nc.ui.Demo" } as never))).toEqual({ source: a.source, entry: "nc/ui/Demo.class", archive: true });
  });
  it("散类与资源可区分，越界路径拒绝", () => {
    const a = { source: "D:\\NC\\modules\\pp\\hyext\\classes", entry: "nc/ui/Demo.class", archive: false };
    expect(parseLibraryUri(libraryUri(a))).toEqual(a);
    for (const uri of ["jdt://contents/a.jar/Demo.class", "nc-library://files/a.jar/%2E%2E/a.xml", "nc-library://files/a.jar/%ZZ", "nc-library://files/a.jar/a%5Cb.xml"]) expect(parseLibraryUri(uri)).toBeNull();
  });
  it("附件源码明确标注只读来源，反编译和原始资源保持各自类型", () => {
    const target = { source: "D:/NC/a.jar", entry: "p/Outer$Inner.class", archive: true };
    const uri = libraryUri(target);
    const meta = libraryTabMeta(uri, target, { text: "class Outer {}", decompiled: false, sourceOrigin: "D:/NC/sources.jar ! p/Outer.java" });
    expect(meta).toMatchObject({ virtual: "source", readOnly: true, sourceOrigin: "D:/NC/sources.jar ! p/Outer.java", name: "Outer$Inner.class" });
    expect(libraryTabMeta(uri, target, { text: "class Outer {}", decompiled: true }).virtual).toBe("decompiled");
    expect(libraryTabMeta(uri, { ...target, entry: "p/a.xml" }, { text: "<a/>", decompiled: false }).virtual).toBe("resource");
  });
  it("刷新附件只匹配完整二进制路径，同名其他 JAR 不刷新", () => {
    expect(sameLibrarySource("D:/NC/one/a.jar", "D:\\NC\\one\\a.jar")).toBe(true);
    expect(sameLibrarySource("\\\\?\\D:\\NC\\one\\a.jar", "D:/NC/one/a.jar")).toBe(true);
    expect(sameLibrarySource("D:/NC/one/a.jar", "D:/NC/two/a.jar")).toBe(false);
  });
});
