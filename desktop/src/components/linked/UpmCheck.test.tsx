// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpmCheck } from "./UpmCheck";
import type { UpmReport } from "../../lib/upm";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.invoke.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const report = (over: Partial<UpmReport> = {}): UpmReport => ({
  stats: { files: 29, projectFiles: 29, productFiles: 0, components: 39, interfaces: 39, modules: 8 },
  issues: [],
  notes: [],
  classCheckComplete: true,
  ...over,
});

const base = {
  running: false,
  deep: false,
  error: null,
  stale: false,
  elapsedMs: 1200,
  onRun: () => {},
};

describe("UPM 装配卡", () => {
  /**
   * 这条是本组件最要紧的一句：没有 jar 类索引时 `missing-*` 根本没跑。
   * 界面如果只显示一片绿，会被读成「装配都没问题」——那是撒谎。
   */
  it("没做类存在性判定时必须说出来", () => {
    act(() =>
      root.render(<UpmCheck {...base} report={report({ classCheckComplete: false })} />),
    );
    expect(container.textContent).toContain("没有判定");
    expect(container.textContent).toContain("深度校验");
  });

  it("深度校验后不再说「没判定」，且空结果给肯定结论", () => {
    act(() => root.render(<UpmCheck {...base} report={report()} />));
    expect(container.textContent).not.toContain("没有判定");
    expect(container.textContent).toContain("没有悬空的接口/实现");
  });

  it("错误排在提示前面", () => {
    act(() =>
      root.render(
        <UpmCheck
          {...base}
          report={report({
            issues: [
              {
                kind: "module-mismatch",
                severity: "warning",
                module: "ic",
                path: "ic/META-INF/icwl.upm",
                className: "",
                detail: "声明 puwl",
              },
              {
                kind: "missing-impl",
                severity: "error",
                module: "ic",
                path: "ic/META-INF/aiersign.upm",
                className: "nc.impl.so.AierPrintAndSignServiceImpl",
                detail: "找不到实现类",
              },
            ],
          })}
        />,
      ),
    );
    const text = container.textContent ?? "";
    // 错误（实现类缺失）必须排在提示（模块名不符）之前，否则最严重的问题被埋
    expect(text.indexOf("实现类缺失")).toBeLessThan(text.indexOf("模块名不符"));
    expect(text).toContain("1");
    expect(text).toContain("找不到实现类");
  });

  it("校验失败时显示原因，而不是留一片空白", () => {
    act(() => root.render(<UpmCheck {...base} error="类索引不可用：超时" report={null} />));
    expect(container.textContent).toContain("校验失败");
    expect(container.textContent).toContain("超时");
  });
});
