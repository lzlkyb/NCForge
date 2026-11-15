import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const mocks = vi.hoisted(() => ({ hasRoot: true, loading: false, error: "请求超时" }));
vi.mock("../../lib/callHierarchy", () => ({ useCallState: () => ({ root: mocks.hasRoot ? { name: "lastMethod", detail: "" } : null, incoming: [], outgoing: [], loading: mocks.loading, error: mocks.error }), openCallItem: vi.fn() }));
vi.mock("../../lib/typeHierarchy", () => ({ useTypeState: () => ({ root: mocks.hasRoot ? { qualifiedName: "demo.LastType", kind: "class", abstract: false } : null, supertypes: [], subtypes: [], loading: mocks.loading, error: mocks.error }), kindLabel: () => "类", typeHierarchyKey: () => "Ctrl+H", openTypeEntry: vi.fn(), openTypeHierarchy: vi.fn() }));
vi.mock("../../lib/workspace", () => ({ baseName: (value: string) => value }));
import { CallHierarchyPanel } from "./CallHierarchyPanel";
import { TypeHierarchyPanel } from "./TypeHierarchyPanel";
beforeEach(() => { mocks.hasRoot = true; mocks.loading = false; mocks.error = "请求超时"; });
describe.each([CallHierarchyPanel, TypeHierarchyPanel])("层级面板反馈", Panel => {
  it("存在上次结果时显示本次错误与结果说明", () => {
    const html = renderToStaticMarkup(<Panel />);
    expect(html).toContain('role="alert"'); expect(html).toContain("请求超时"); expect(html).toContain("上次成功查询");
  });
  it("首次查询时显示加载状态", () => {
    mocks.hasRoot = false; mocks.loading = true; mocks.error = "";
    const html = renderToStaticMarkup(<Panel />);
    expect(html).toContain('role="status"'); expect(html).toContain("正在查询");
  });
});
