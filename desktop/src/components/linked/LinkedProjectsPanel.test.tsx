// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinkedProjectsPanel } from "./LinkedProjectsPanel";
import { clearLinkedGraphCache } from "../../hooks/useLinkedGraph";
import { setSession } from "../../lib/workspaceSession";
import type { LinkedGraph, LinkedOverride } from "../../lib/linkedProjects";
import type { LinkedSection } from "../../lib/linkedDialog";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));
vi.mock("../ui/toast", () => ({ toast: mocks.toast }));

const dirs = (n: number, prefix = "C:\\x") =>
  Array.from({ length: n }, (_, i) => `${prefix}\\d${i}`);

/** 真机形状（C:\work\aier\EyePortal）：9 + 8 + 35 = 52。 */
const graph = (): LinkedGraph => ({
  primary: "EyePortal",
  primaryRoot: "C:\\work\\aier\\EyePortal",
  workspace: "C:\\work\\aier",
  projects: [
    {
      name: "EyePortal",
      root: "C:\\work\\aier\\EyePortal",
      origin: "primary",
      depth: 0,
      exported: false,
      classDirs: dirs(9, "C:\\work\\aier\\EyePortal"),
      disabled: false,
      hasClasspath: true,
    },
    {
      name: "pm",
      root: "C:\\work\\aier\\pm",
      origin: "classpath",
      depth: 1,
      exported: true,
      classDirs: dirs(8, "C:\\work\\aier\\pm"),
      disabled: false,
      hasClasspath: true,
    },
    {
      name: "newar",
      root: null,
      origin: "legacy",
      depth: 2,
      exported: false,
      classDirs: dirs(35, "C:\\work\\aier\\newar"),
      disabled: false,
      hasClasspath: false,
    },
  ],
  extraDirs: ["C:\\extra\\classes"],
  projectDirCount: 52,
  ncHomeDirCount: 160,
  totalDirCount: 212,
  notes: ["disable newar：连带剪掉它往下传递的依赖"],
});

let stored: LinkedOverride[] = [];
/** 保存过一次覆盖表之后模拟「链变了」（保存会触发 reload） */
let chainChanged = false;

/** 后端 `stale_diagnostics` 的两种结论（`stale_diagnostics` 只产工程级诊断）。 */
const artifacts = () => [
  {
    kind: "stale",
    project: "pm",
    message: "「pm」的产物比源码旧（最新 class 比最新 .java 早 3 天），本次编译/启动可能用到旧类",
    file: null,
  },
  {
    kind: "no-output",
    project: "newar",
    message: "「newar」有 339 个源文件，但产物目录里一个 class 都没有，启动时会用 jar 里的旧类",
    file: null,
  },
];

const invokeImpl = async (cmd: string, args?: Record<string, unknown>) => {
  if (cmd === "linked_projects") {
    const g = graph();
    if (chainChanged) {
      // 真机行为：`disable newar` 之后它**仍然留在链上**（只是 disabled、不再贡献目录），
      // 工程名序列一模一样 ⇒ 只比名字的签名会漏判，必须把目录数与停用状态一起算
      const newar = g.projects.find((p) => p.name === "newar")!;
      newar.disabled = true;
      newar.classDirs = [];
    }
    return g;
  }
  if (cmd === "check_artifacts") return artifacts();
  if (cmd === "get_config") return { linked_overrides: stored };
  if (cmd === "set_linked_overrides") {
    stored = (args?.overrides ?? []) as LinkedOverride[];
    chainChanged = true;
    return stored;
  }
  throw new Error(`unexpected command: ${cmd}`);
};

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
const scrollTo = vi.fn();

const render = async (section: LinkedSection = "chain", active = true) => {
  await act(async () =>
    root.render(<LinkedProjectsPanel section={section} active={active} />),
  );
  await act(async () => {}); // 等 linked_projects + get_config 落回状态
};

const rows = () => [...container.querySelectorAll<HTMLElement>(".lnk-item")];
const rowOf = (name: string) =>
  rows().find((li) => li.querySelector(".lnk-name")?.textContent?.includes(name))!;
const buttonIn = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as
    | HTMLButtonElement
    | undefined;
const saveButton = () => buttonIn(container, "保存覆盖表");
const callsOf = (cmd: string) => mocks.invoke.mock.calls.filter(([c]) => c === cmd);

beforeEach(() => {
  vi.clearAllMocks();
  clearLinkedGraphCache();
  setSession({ root: "C:\\work\\aier\\EyePortal" });
  stored = [];
  chainChanged = false;
  mocks.invoke.mockImplementation(invokeImpl);
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    writable: true,
    value: scrollTo,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
  setSession({ root: null });
});

describe("工程关联面板", () => {
  it("按有效顺序列出依赖链，并显示目录数、追加目录与解析说明", async () => {
    await render();

    // 根目录要显式带出去：不带就去读配置里的 workspace_root，两者可能不一致
    expect(mocks.invoke).toHaveBeenCalledWith("linked_projects", { root: "C:\\work\\aier\\EyePortal" });

    const names = rows().map((li) => li.querySelector(".lnk-name")?.textContent?.trim());
    expect(names).toEqual(["EyePortal", "pm", "newar"]);
    expect(rowOf("EyePortal").textContent).toContain("主工程");
    expect(rowOf("pm").textContent).toContain("8 个目录");
    expect(rowOf("pm").textContent).toContain("往下传递");
    // `.classpath` 写了但磁盘上找不到：必须显式标出来，否则用户以为它参与了
    expect(rowOf("newar").textContent).toContain("目录找不到");
    expect(rowOf("newar").textContent).toContain("无 .classpath");

    expect(container.textContent).toContain("类目录 212 个");
    expect(container.textContent).toContain("工程侧 52 + NC home 160");
    expect(container.textContent).toContain("C:\\extra\\classes");
    expect(container.textContent).toContain("disable newar：连带剪掉它往下传递的依赖");
  });

  it("行内「停用」只改草稿：不落盘，保存后整表提交并重读依赖链", async () => {
    await render();
    expect(callsOf("linked_projects")).toHaveLength(1);

    await act(async () => buttonIn(rowOf("pm"), "停用")!.click());
    // 草稿里出现了这一条，但还没发保存请求
    expect(callsOf("set_linked_overrides")).toHaveLength(0);
    expect(buttonIn(rowOf("pm"), "取消停用")).toBeTruthy();
    expect(saveButton()?.disabled).toBe(false);

    await act(async () => saveButton()!.click());

    // 全量替换：提交的是整张表（此时只有这一条），不是「增量一条」
    expect(mocks.invoke).toHaveBeenCalledWith("set_linked_overrides", {
      overrides: [{ action: "disable", target: "pm", dir: null }],
    });
    // 保存后必须重读依赖链：目录数与顺序都可能变
    expect(callsOf("linked_projects")).toHaveLength(2);
    expect(saveButton()?.disabled).toBe(true);
  });

  it("草稿攒了两条，提交的是两条（顺序即优先级）", async () => {
    await render();

    await act(async () => buttonIn(rowOf("pm"), "停用")!.click());
    await act(async () => buttonIn(rowOf("newar"), "排前")!.click());
    await act(async () => saveButton()!.click());

    expect(mocks.invoke).toHaveBeenCalledWith("set_linked_overrides", {
      overrides: [
        { action: "disable", target: "pm", dir: null },
        { action: "front", target: "newar", dir: null },
      ],
    });
  });

  it("主工程不能排前（按钮禁用），取消停用会退回空草稿", async () => {
    await render();
    expect(buttonIn(rowOf("EyePortal"), "排前")?.disabled).toBe(true);

    await act(async () => buttonIn(rowOf("pm"), "停用")!.click());
    await act(async () => buttonIn(rowOf("pm"), "取消停用")!.click());
    expect(saveButton()?.disabled).toBe(true);
  });

  it("配置里已有的覆盖会回填成草稿，此时不算改动", async () => {
    stored = [{ action: "front", target: "newar", dir: null }];
    await render();

    const list = container.querySelector(".lnk-ovs");
    expect(list?.textContent).toContain("排前");
    expect(list?.textContent).toContain("newar");
    expect(saveButton()?.disabled).toBe(true);
    expect(buttonIn(rowOf("newar"), "取消排前")).toBeTruthy();
  });

  it("「重新读取」再发一次 linked_projects", async () => {
    await render();
    await act(async () => buttonIn(container, "重新读取")!.click());
    expect(callsOf("linked_projects")).toHaveLength(2);
  });

  it("检查产物：用当前主工程根发命令，结论同时进列表和链上行内徽章", async () => {
    await render();

    const btn = buttonIn(container, "检查产物")!;
    expect(btn.disabled).toBe(false);
    await act(async () => btn.click());
    await act(async () => {});

    // 必须显式带 primaryRoot：不带就去读配置里的 workspace_root，两者可能不一致
    expect(mocks.invoke).toHaveBeenCalledWith("check_artifacts", {
      root: "C:\\work\\aier\\EyePortal",
    });

    const items = [...container.querySelectorAll(".lnk-chk-item")];
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("产物旧");
    expect(items[1].textContent).toContain("无产物");
    // 行内也要标——否则用户得在两个地方对照才知道是哪一行
    expect(rowOf("pm").textContent).toContain("产物旧");
    expect(rowOf("newar").textContent).toContain("无产物");
    expect(container.textContent).toContain("2 个工程有问题");
  });

  it("覆盖表有未保存草稿时不给检查（检查读的是已落盘的配置）", async () => {
    await render();
    expect(buttonIn(container, "检查产物")!.disabled).toBe(false);

    await act(async () => buttonIn(rowOf("pm"), "停用")!.click());
    expect(buttonIn(container, "检查产物")!.disabled).toBe(true);
    expect(container.textContent).toContain("先保存再检查");
    expect(callsOf("check_artifacts")).toHaveLength(0);
  });

  it("检查完链又变了：保留结论但标成过期，不假装还准", async () => {
    await render();
    await act(async () => buttonIn(container, "检查产物")!.click());
    await act(async () => {});
    expect(container.textContent).not.toContain("依赖链已经变了");

    // 保存覆盖表 → reload 返回多一个工程的链 → 签名变了
    await act(async () => buttonIn(rowOf("pm"), "停用")!.click());
    await act(async () => saveButton()!.click());
    await act(async () => {});

    expect(container.textContent).toContain("依赖链已经变了");
    // 结论本身没被丢掉（用户刚等完十几秒，直接清空等于白等）
    expect(container.querySelectorAll(".lnk-chk-item")).toHaveLength(2);
  });

  it("关着不读盘；打开才读；60 秒内重开走缓存不再扫", async () => {
    await render("chain", false);
    expect(callsOf("linked_projects")).toHaveLength(0);

    await render("chain", true);
    expect(callsOf("linked_projects")).toHaveLength(1);

    // 关掉再打开：缓存还新鲜，不能重新读盘
    await render("chain", false);
    await render("chain", true);
    expect(callsOf("linked_projects")).toHaveLength(1);

    // 显式「重新读取」必须绕过缓存
    await act(async () => buttonIn(container, "重新读取")!.click());
    expect(callsOf("linked_projects")).toHaveLength(2);
  });

  it("从问题面板进来：打开后滚到请求的区块（产物检查），而不是停在顶部", async () => {
    await render("artifacts");
    expect(scrollTo).toHaveBeenCalled();
    const anchors = [...container.querySelectorAll<HTMLElement>(".lnk-anchor")];
    expect(anchors).toHaveLength(3);
    expect(anchors[2].classList.contains("lnk-flash")).toBe(true);
    expect(anchors[0].classList.contains("lnk-flash")).toBe(false);
  });
});
