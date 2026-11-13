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

  it("连点两个「在右侧打开」，右侧落在后点的那个", async () => {
    // 只加标签、不抢 activePath：真实的 openFile 抢不抢是它自己的事，
    // 这里要验的是 openSplit 会不会让先点的那次把右侧抢回去。
    const openTab = (path: string) => {
      setSession({ tabs: (tabs) => [...tabs, tabMetaFromDisk(path, { text: "", encoding: "UTF-8", hasBom: false, eol: "LF", lossless: true, mtimeMs: 0, size: 1 })] });
      return true;
    };
    const waiters: Array<() => void> = [];
    await render((path) => new Promise<boolean>((resolve) => {
      waiters.push(() => resolve(openTab(path)));
    }));
    let first!: Promise<void>, second!: Promise<void>;
    await act(async () => {
      first = api.openSplit("C:\\w\\A.java");
      second = api.openSplit("C:\\w\\B.java");
    });
    // 后点的先读完：先点的那次回来时不能再把右侧抢回 A
    await act(async () => { waiters[1](); await second; });
    expect(getSession().splitPath).toBe("C:\\w\\B.java");
    await act(async () => { waiters[0](); await first; });
    expect(getSession().splitPath).toBe("C:\\w\\B.java");
  });
});
