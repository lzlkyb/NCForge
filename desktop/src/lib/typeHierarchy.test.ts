import { describe, expect, it, vi } from "vitest";

// 纯函数测试跑在 node 环境：monaco 的 ESM 在导入期就摸 window，必须先挡掉。
// 本文件只测换算 / 文案，不碰编辑器与语言服务。
vi.mock("./monacoSetup", () => ({ monaco: { editor: {}, languages: {}, MarkerSeverity: {} } }));

import { explainTypeHierarchyError, kindLabel, toTypeEntry, typeHierarchyKey, type LspTypeEntry } from "./typeHierarchy";

describe("类型层级条目换算", () => {
  it("把 LSP 的 0 基行列换成 1 基，并把 file:// URI 换成真实路径", () => {
    const e = toTypeEntry({
      name: "Shape",
      qualifiedName: "demo.Shape",
      kind: "interface",
      abstract: false,
      depth: 0,
      direct: false,
      location: { uri: "file:///C:/ws/src/demo/Shape.java", range: { start: { line: 4, character: 6 } } },
    });
    expect(e).toMatchObject({
      name: "Shape",
      qualifiedName: "demo.Shape",
      kind: "interface",
      path: "C:\\ws\\src\\demo\\Shape.java",
      line: 5,
      column: 7,
    });
  });

  it("二进制类型没有 location：uri / path 都为 null，行列退回 1", () => {
    const e = toTypeEntry({ name: "Object", qualifiedName: "java.lang.Object", kind: "class", depth: 2, direct: false });
    expect(e).not.toBeNull();
    expect(e!.uri).toBeNull();
    expect(e!.path).toBeNull();
    expect(e!.line).toBe(1);
    expect(e!.column).toBe(1);
    expect(e!.depth).toBe(2);
  });

  it("jdt:// 类型保留 uri（面板可走只读标签），但没有真实路径", () => {
    const e = toTypeEntry({
      name: "BaseDAO",
      kind: "class",
      location: { uri: "jdt://contents/base.jar/nc/bs/dao/BaseDAO.class?=x", range: { start: { line: 0, character: 0 } } },
    });
    expect(e!.uri).toContain("jdt://");
    expect(e!.path).toBeNull();
  });

  it("缺字段时不瞎猜：没有 name 返回 null，kind 不认识的按类，depth 负数归 0，direct 只认 true", () => {
    expect(toTypeEntry(null)).toBeNull();
    expect(toTypeEntry({ qualifiedName: "demo.NoName" })).toBeNull();
    const e = toTypeEntry({ name: "A", kind: "weird", depth: -3, direct: "yes" } as unknown as LspTypeEntry);
    expect(e!.kind).toBe("class");
    expect(e!.depth).toBe(0);
    expect(e!.direct).toBe(false);
  });

  it("注解 / 枚举 / 接口的显示名", () => {
    expect(kindLabel("annotation")).toBe("注解");
    expect(kindLabel("enum")).toBe("枚举");
    expect(kindLabel("interface")).toBe("接口");
    expect(kindLabel("class")).toBe("类");
  });
});

describe("类型层级入口键", () => {
  it("IDEA 用 Ctrl+H，Eclipse 用 Ctrl+T", () => {
    expect(typeHierarchyKey("idea")).toBe("Ctrl+H");
    expect(typeHierarchyKey("eclipse")).toBe("Ctrl+T");
  });
});

describe("类型层级报错翻译", () => {
  it("没装扩展 bundle 时换成人话，不再透出英文命令名", () => {
    const msg = explainTypeHierarchyError("Error: No delegateCommandHandler for ncforge.typeHierarchy");
    expect(msg).toContain("没有装上类型层级组件");
    expect(msg).not.toContain("delegateCommandHandler");
  });

  it("其它错误原样返回，不吞掉服务端给的原因", () => {
    expect(explainTypeHierarchyError("workspace/executeCommand 超时")).toBe("workspace/executeCommand 超时");
  });
});
