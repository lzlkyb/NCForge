// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TabMeta } from "../../lib/workspaceSession";
import { RESOURCE_DOWNLOAD_EVENT, RESOURCE_OPEN_EVENT } from "../../lib/resourceActions";

const mocks = vi.hoisted(() => ({ lang: { enabled: true, state: "error", message: "", autoStart: true }, restart: vi.fn() }));
vi.mock("../../lib/lang", () => ({ useLangView: () => mocks.lang, restartLang: mocks.restart, startLangNow: vi.fn() }));
import { ResourceDownloadEntry } from "./ResourceDownloadEntry";
import { ResourceDownloadButton } from "./ResourceDownloadButton";
import { SvnScanNotice } from "../svn/SvnScanNotice";
import { EditorBanners } from "../workspace/EditorBanners";
import { LangBadge } from "../workspace/LangBadge";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const requests: string[] = [];
const requested = (e: Event) => requests.push((e as CustomEvent<{ id: string }>).detail.id);
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  requests.length = 0; mocks.restart.mockReset(); mocks.restart.mockResolvedValue(undefined);
  window.addEventListener(RESOURCE_DOWNLOAD_EVENT, requested);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); window.removeEventListener(RESOURCE_DOWNLOAD_EVENT, requested);
});
const click = async (label: string) => {
  const button = [...host.querySelectorAll("button")].find(b => b.textContent?.includes(label) || b.getAttribute("aria-label") === label);
  expect(button).toBeDefined(); await act(async () => button!.click());
};

describe("功能缺失下载入口", () => {
  it("SVN 缺失可直接下载；认证失败仍只提供认证与重扫", async () => {
    await act(async () => root.render(<SvnScanNotice error="找不到 SVN 组件（ncsvn.jar / svnkit.jar）" onAuth={vi.fn()} onRefresh={vi.fn()} fetching={false} />));
    await click("下载 SVN 组件"); expect(requests).toEqual(["svnkit"]);
    await act(async () => root.render(<SvnScanNotice error="AUTH: credentials rejected" onAuth={vi.fn()} onRefresh={vi.fn()} fetching={false} />));
    expect(host.textContent).not.toContain("下载 SVN 组件");
  });
  it("语言服务缺组件点击下载，其余启动错误点击重试", async () => {
    mocks.lang.message = "找不到可用的 Java 语言服务组件（jdt.ls）";
    await act(async () => root.render(<LangBadge activePath="D:/p/A.java" />));
    await click("代码智能缺少组件 · 下载"); expect(requests).toEqual(["jdtls"]); expect(mocks.restart).not.toHaveBeenCalled();
    mocks.lang.message = "Java 启动失败";
    await act(async () => root.render(<LangBadge activePath="D:/p/A.java" />));
    await click("代码智能不可用 · 重试"); expect(mocks.restart).toHaveBeenCalledWith("D:/p/A.java");
  });
  it("CFR 缺失桩显示下载，普通反编译错误不显示下载", async () => {
    const active = { path: "jdt://A", virtual: "stub", decompileError: "找不到反编译组件（CFR）" } as TabMeta;
    const props = { activePath: active.path, conflictPath: null, encodingIssue: null, showLargeHint: false,
      onUnifyEol: vi.fn(), onReload: vi.fn(), onOverwriteSave: vi.fn(), onSaveUtf8: vi.fn(), onDismissLargeHint: vi.fn() };
    await act(async () => root.render(<EditorBanners {...props} active={active} />));
    await click("下载反编译组件"); expect(requests).toEqual(["cfr"]);
    await act(async () => root.render(<EditorBanners {...props} active={{ ...active, decompileError: "CFR 超时" }} />));
    expect(host.textContent).not.toContain("下载反编译组件");
  });
  it("编译器按钮请求单包 ecj，标题栏始终可以重开下载面板", async () => {
    const opened = vi.fn(); window.addEventListener(RESOURCE_OPEN_EVENT, opened);
    try {
      await act(async () => root.render(<><ResourceDownloadButton id="ecj" /><ResourceDownloadEntry /></>));
      await click("下载 Java 编译器"); expect(requests).toEqual(["ecj"]);
      await click("组件下载与管理"); expect(opened).toHaveBeenCalledTimes(1);
    } finally { window.removeEventListener(RESOURCE_OPEN_EVENT, opened); }
  });
});
