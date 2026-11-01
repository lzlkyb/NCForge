// @vitest-environment jsdom
/**
 * 「表不存在」确认态必须和核对结果同生共死。
 *
 * 出包按钮的二次确认靠 `armed`：没有核对结果时它没有任何意义，留在 true 上
 * 就等于把确认绕过去了。切页会把 TableCheck 卸载并回调 `onResult(null)`，
 * 若只清 `check` 不清 `armed`，切回来点一次就直接出包。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { useCheckGuard } from "./useCheckGuard";
import type { SourceCheck } from "../lib/db";

let latest: ReturnType<typeof useCheckGuard>;
function Probe({ chosenKey }: { chosenKey: string }) {
  latest = useCheckGuard(chosenKey);
  return null;
}

let root: Root | null = null;
const mount = (chosenKey: string) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Probe chosenKey={chosenKey} />));
};

const check = (missingTables: number): SourceCheck => ({
  files: 1,
  skipped: 0,
  tables: 1,
  columns: 1,
  missingTables,
  missingColumns: 0,
  issues: [],
  schemaTables: 0,
  schemaAgeSecs: 0,
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

describe("useCheckGuard", () => {
  it("核对结果被清空时退回未确认态", () => {
    mount("a.java");
    act(() => latest.setCheck(check(2)));
    act(() => latest.setArmed(true));
    expect(latest.armed).toBe(true);

    act(() => latest.setCheck(null));
    expect(latest.armed).toBe(false);
  });

  it("勾选变化会同时清掉结果与确认态", () => {
    mount("a.java");
    act(() => latest.setCheck(check(1)));
    act(() => latest.setArmed(true));

    act(() => root?.render(<Probe chosenKey="b.java" />));
    expect(latest.check).toBeNull();
    expect(latest.armed).toBe(false);
  });
});
