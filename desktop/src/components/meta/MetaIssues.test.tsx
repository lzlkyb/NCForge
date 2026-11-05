// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { BmfIssue } from "../../lib/bmf";
import { MetaIssues } from "./MetaIssues";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const issue = (over: Partial<BmfIssue> = {}): BmfIssue => ({
  id: "",
  code: "C001",
  severity: "error",
  title: "组件名称为空",
  detail: "component/@name 是空串",
  why: "注册项无法定位",
  action: "填写组件编码",
  file: "D:/demo.bmf",
  line: 4,
  component: "demo",
  entity: "",
  attr: "",
  ...over,
});

it("行号按后端 1 基口径显示，不再 +1", () => {
  act(() => root.render(<MetaIssues issues={[issue()]} loading={false} error={null} />));
  expect(host.textContent).toContain("第 4 行");
  expect(host.textContent).not.toContain("第 5 行");
});

it("同一编码的多条问题（实体/属性为空）都能各自渲染", () => {
  act(() =>
    root.render(
      <MetaIssues
        issues={[
          issue({ code: "C009", title: "实体未声明表名", line: null }),
          issue({ code: "C010", title: "实体没有主键", line: null }),
        ]}
        loading={false}
        error={null}
      />,
    ),
  );
  expect(host.querySelectorAll(".meta-issue")).toHaveLength(2);
  expect(host.textContent).toContain("实体未声明表名");
  expect(host.textContent).toContain("实体没有主键");
});
