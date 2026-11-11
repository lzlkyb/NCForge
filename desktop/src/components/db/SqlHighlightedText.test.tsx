// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { SqlHighlightedText } from "./SqlHighlightedText";
it("语法着色保持完整SQL文本并安全显示HTML、注释和绑定变量", () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("pre"), root = createRoot(host);
  const text = "select /*+ index(p) */ p.id, q'[it's <script>evil()</script>]'\nfrom project p where p.id = :id -- from fake";
  act(() => root.render(<SqlHighlightedText text={text} dialect="plsql" />));
  expect(host.textContent).toBe(text); expect(host.querySelector("script")).toBeNull();
  expect(host.querySelector('[data-sql-kind="string"]')?.textContent).toContain("<script>");
  expect(host.querySelector('[data-sql-kind="parameter"]')?.textContent).toBe(":id");
  expect(host.querySelector('[data-sql-kind="hint"]')?.textContent).toBe("/*+ index(p) */");
  const large = "select * from t;".repeat(15000);
  act(() => root.render(<SqlHighlightedText text={large} dialect="plsql" />));
  expect(host.textContent).toBe(large); expect(host.querySelector("span")).toBeNull();
  act(() => root.unmount());
});
