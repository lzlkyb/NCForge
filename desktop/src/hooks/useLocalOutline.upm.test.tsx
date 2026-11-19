// @vitest-environment jsdom
/**
 * useLocalOutline 的 upm 分支：走后端结构化解析（传当前模型文本），
 * 编辑去抖、陈旧回包守卫、失败清空。非 upm 路径不受影响。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useLocalOutline } from "./useLocalOutline";
import type { UpmFile } from "../lib/upm";

const h = vi.hoisted(() => ({
  upmFile: vi.fn(),
  text: "",
  version: 1,
  listener: null as null | (() => void),
  model: null as null | Record<string, unknown>,
}));
vi.mock("../lib/upm", () => ({ upmFile: h.upmFile }));
vi.mock("../lib/editorStore", () => ({ getModel: () => h.model }));
vi.mock("../lib/documentOutlineModel", () => ({ currentDocumentOutline: () => [] }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const upmText = '<module name="m">\n<component><interface>nc.itf.I</interface><implementation>nc.impl.C</implementation></component>\n</module>';
const upmResult: UpmFile = {
  declaredModule: "m", module: "m", path: "C:/w/m/META-INF/a.upm", origin: "project",
  components: [{ interface: "nc.itf.I", implementation: "nc.impl.C", visibility: "public", remote: false, singleton: false, tx: "", alias: false, priority: null }],
};

let host: HTMLDivElement, root: Root;
function Harness({ path }: { path: string | null }) {
  const symbols = useLocalOutline(path, 1);
  return <div>{symbols.map(s => `${s.name}@${s.line}`).join(",")}</div>;
}
beforeEach(() => {
  vi.useFakeTimers();
  h.upmFile.mockReset();
  h.text = upmText;
  h.version = 1;
  h.listener = null;
  h.model = {
    getValue: () => h.text,
    getValueLength: () => h.text.length,
    getVersionId: () => h.version,
    onDidChangeContent: (cb: () => void) => { h.listener = cb; return { dispose: () => { h.listener = null; } }; },
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

it("upm 传当前模型文本给后端，符号落在接口行", async () => {
  h.upmFile.mockResolvedValue(upmResult);
  await act(async () => root.render(<Harness path="C:/w/m/META-INF/a.upm" />));
  expect(h.upmFile).toHaveBeenCalledWith("C:/w/m/META-INF/a.upm", upmText);
  expect(host.textContent).toBe("I@2");
});

it("编辑后去抖重解析；旧版本的迟到回包被丢弃", async () => {
  let stale!: (v: UpmFile) => void;
  h.upmFile.mockImplementationOnce(() => new Promise<UpmFile>(r => { stale = r; }));
  await act(async () => root.render(<Harness path="C:/w/m/META-INF/a.upm" />));
  // 用户编辑：文本与版本都变了
  h.text = upmText.replace("nc.itf.I", "nc.itf.I2");
  h.version = 2;
  const fresh: UpmFile = { ...upmResult, components: [{ ...upmResult.components[0], interface: "nc.itf.I2" }] };
  h.upmFile.mockResolvedValue(fresh);
  await act(async () => { h.listener?.(); vi.advanceTimersByTime(180); });
  expect(h.upmFile).toHaveBeenLastCalledWith("C:/w/m/META-INF/a.upm", h.text);
  expect(host.textContent).toBe("I2@2");
  // 第一次（旧版本）的回包这时才到：不能盖掉新结果
  await act(async () => { stale(upmResult); });
  expect(host.textContent).toBe("I2@2");
});

it("后端失败清空符号，不保留上一个文件的清单", async () => {
  h.upmFile.mockRejectedValue(new Error("boom"));
  await act(async () => root.render(<Harness path="C:/w/m/META-INF/a.upm" />));
  expect(host.textContent).toBe("");
});

it("非 upm 路径不调后端解析", async () => {
  await act(async () => root.render(<Harness path="C:/w/m/META-INF/a.xml" />));
  expect(h.upmFile).not.toHaveBeenCalled();
});

it("没有编辑模型时读磁盘（text 传 undefined）", async () => {
  h.model = null;
  h.upmFile.mockResolvedValue(upmResult);
  await act(async () => root.render(<Harness path="C:/w/m/META-INF/a.upm" />));
  expect(h.upmFile).toHaveBeenCalledWith("C:/w/m/META-INF/a.upm", undefined);
  // 无文本可配对：兜底第 1 行，条目不丢
  expect(host.textContent).toBe("I@1");
});