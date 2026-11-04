// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { TxBar } from "./TxBar";
import { __resetDbForTest, setTx } from "../../lib/dbStore";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => { __resetDbForTest(); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); __resetDbForTest(); });
it("独立槽状态未知时不展示主会话事务，已知槽与primary各读自己的写入", () => {
  const primary = { autoCommit: false, statements: 2, rows: 4, since: 1 };
  setTx("c1", primary);
  act(() => root.render(<TxBar connId="c1" slot="1" />));
  expect(host.querySelector('[role="status"]')).toBeNull();
  act(() => root.render(<TxBar connId="c1" slot="1" tx={{ ...primary, statements: 3 }} />));
  expect(host.textContent).toContain("独立会话 1");
  expect(host.querySelector("b")?.textContent).toBe("3");
  act(() => root.render(<TxBar connId="c1" />));
  expect(host.querySelector("b")?.textContent).toBe("2");
  expect(host.textContent).not.toContain("独立会话 1");
});
