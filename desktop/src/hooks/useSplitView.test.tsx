// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useSplitView } from "./useSplitView";
import { getSession, setSession } from "../lib/workspaceSession";
import { tabMetaFromDisk } from "../lib/tabSession";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let api: ReturnType<typeof useSplitView>;

function Probe({ open }: { open: (path: string) => Promise<boolean> }) {
  api = useSplitView(open);
  return null;
}

async function render(open: (path: string) => Promise<boolean>) {
  await act(async () => root.render(<Probe open={open} />));
}
const openSuccessfully = async (path: string) => {
  setSession({ tabs: [tabMetaFromDisk(path, { text: "class A {}", encoding: "UTF-8", hasBom: false, eol: "LF", lossless: true, mtimeMs: 0, size: 10 })], activePath: path });
  return true;
};

beforeEach(async () => {
  setSession({ root: "C:\\w", tabs: [], activePath: null, splitPath: null });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("分屏会话", () => {
  it("打开成功后 splitPath 指向该文件", async () => {
    await render(openSuccessfully);
    await act(async () => {
      await api.openSplit("C:\\w\\A.java");
    });
    expect(getSession().splitPath).toBe("C:\\w\\A.java");
  });

  it("打开失败时不分屏（不会留下一个空壳）", async () => {
    await render(async () => false);
    await act(async () => {
      await api.openSplit("C:\\w\\missing.java");
    });
    expect(getSession().splitPath).toBeNull();
  });

  it("closeSplit 清掉分屏", async () => {
    await render(openSuccessfully);
    await act(async () => {
      await api.openSplit("C:\\w\\A.java");
    });
    await act(async () => api.closeSplit());
    expect(getSession().splitPath).toBeNull();
  });
});
