// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileTree, type FileTreeHandle } from "./FileTree";
import { setSession } from "../../lib/workspaceSession";
import { setCompactPackages, setRevealOnOpen } from "../../lib/treeViewPrefs";
import { ViewActivityContext } from "../../lib/viewActivity";
import { clearBookmarks, loadBookmarks, toggleBookmark } from "../../lib/bookmarks";
import type { LinkedProject } from "../../lib/linkedProjects";

const mocks = vi.hoisted(() => {
  const fsChanged: {
    handler: ((p: { dirs?: string[]; rescan?: boolean }) => void) | null;
  } = { handler: null };
  return { invoke: vi.fn(), toast: vi.fn(), fsChanged };
});
vi.mock("../../lib/tauri", () => ({
  invoke: mocks.invoke,
  listen: async (
    _event: string,
    handler: (p: { dirs?: string[]; rescan?: boolean }) => void,
  ) => {
    mocks.fsChanged.handler = handler;
    return () => {
      mocks.fsChanged.handler = null;
    };
  },
}));
vi.mock("../ui/toast", () => ({ toast: mocks.toast }));
vi.mock("../../hooks/usePrefersReducedMotion", () => ({
  usePrefersReducedMotion: () => true,
}));

const ROOT = "C:\\w\\newar";
const MODULES = `${ROOT}\\modules`;

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom 没实现滚动：自动定位会调它，给个空桩即可
Element.prototype.scrollIntoView = () => {};

let root: Root;
let container: HTMLDivElement;
const onOpen = vi.fn();
const onCreated = vi.fn();
const onRenamed = vi.fn();
const onDeleted = vi.fn();
const treeRef = createRef<FileTreeHandle>();

const render = async (activePath: string | null = null, projects?: LinkedProject[]) => {
  await act(async () =>
    root.render(
      <ViewActivityContext.Provider value={true}>
        <FileTree
          ref={treeRef}
          root={ROOT}
          projects={projects}
          activePath={activePath}
          onOpen={onOpen}
          onCreated={onCreated}
          onRenamed={onRenamed}
          onDeleted={onDeleted}
          openPaths={[]}
        />
      </ViewActivityContext.Provider>,
    ),
  );
};

const rowByName = (name: string) =>
  [...container.querySelectorAll(".wb-row")].find((el) => el.textContent?.includes(name)) ?? null;

/** 按显示名精确匹配：`aier` 不该命中 `com.aier.erp`。 */
const rowByExact = (name: string) =>
  [...container.querySelectorAll(".wb-row")].find(
    (el) => el.querySelector(".wb-row-name")?.textContent === name,
  ) ?? null;

const rightClick = async (el: Element) =>
  act(async () => {
    el.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }),
    );
  });

const menuItem = (label: string) =>
  [...document.querySelectorAll('[role="menuitem"]')].find((el) =>
    el.textContent?.includes(label),
  ) as HTMLButtonElement | undefined;

const click = async (el: Element | undefined | null) => {
  expect(el).toBeTruthy();
  await act(async () => (el as HTMLElement).click());
};

/** React 受控输入：必须走原生 setter，否则 React 收不到这次变化。 */
const typeInto = async (el: HTMLInputElement, value: string) =>
  act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

const pressEnter = async (el: HTMLInputElement) =>
  act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });

beforeEach(() => {
  vi.clearAllMocks();
  setCompactPackages(true);
  setRevealOnOpen(true);
  // 预置一棵已展开的树，免得每次渲染都去 listDir
  setSession({
    tree: {
      root: ROOT,
      expanded: new Set([ROOT]),
      marks: {},
      dirs: {
        [ROOT]: {
          status: "ok",
          items: [
            { name: "modules", isDir: true, size: 0 },
            { name: "readme.txt", isDir: false, size: 10 },
          ],
        },
      },
    },
  });
  mocks.invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "fs_list_dir") return [];
    if (cmd === "fs_encoding_marks") return [];
    if (cmd === "fs_create") return `${MODULES}\\A.java`;
    if (cmd === "fs_rename") return `${ROOT}\\B.java`;
    if (cmd === "fs_count_files") return 3;
    if (cmd === "fs_delete") return null;
    throw new Error(`unexpected command: ${cmd}`);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("编码标记", () => {
  it("已缓存的标记直接画在行尾，悬停说明说清 Eclipse 会怎么读", async () => {
    setSession({
      tree: {
        root: ROOT,
        expanded: new Set([ROOT]),
        dirs: {
          [ROOT]: {
            status: "ok",
            items: [
              { name: "VoucherBO.java", isDir: false, size: 100 },
              { name: "BillVO.java", isDir: false, size: 100 },
            ],
          },
        },
        marks: {
          [`${ROOT}\\VoucherBO.java`]: {
            path: `${ROOT}\\VoucherBO.java`,
            registered: null,
          },
        },
      },
    });
    await render();

    const bad = rowByName("VoucherBO.java")!;
    expect(bad.querySelector(".wb-enc-badge")?.textContent).toBe("U8");
    expect(bad.getAttribute("title")).toContain("没有登记");
    // 没被标记的文件不该有徽标
    expect(rowByName("BillVO.java")!.querySelector(".wb-enc-badge")).toBeNull();
  });

  it("展开目录时只拿 .java 去问后端，标记回来后补上徽标", async () => {
    setSession({
      tree: { root: null, expanded: new Set(), dirs: {}, marks: {} },
    });
    // 按真实路径回标记：目录里两个文件，只有 .java 会被问
    mocks.invoke.mockImplementation(async (cmd: string, args: { paths?: string[] } = {}) => {
      if (cmd === "fs_list_dir") {
        return [
          { name: "VoucherBO.java", isDir: false, size: 100 },
          { name: "readme.txt", isDir: false, size: 10 },
        ];
      }
      if (cmd === "fs_encoding_marks") {
        return (args.paths ?? []).map((p) => ({ path: p, registered: "GBK" }));
      }
      return [];
    });

    await render();
    await act(async () => {}); // 等标记那一轮 IPC 落回状态

    const called = mocks.invoke.mock.calls.find(([cmd]) => cmd === "fs_encoding_marks");
    expect(called?.[1]).toEqual({ paths: [`${ROOT}\\VoucherBO.java`] });
    expect(rowByName("VoucherBO.java")!.querySelector(".wb-enc-badge")?.textContent).toBe("U8");
    expect(rowByName("readme.txt")!.querySelector(".wb-enc-badge")).toBeNull();
  });
});

describe("书签标记", () => {
  it("有书签的文件行画小旗，删掉书签后小旗跟着消失", async () => {
    setSession({
      tree: {
        root: ROOT,
        expanded: new Set([ROOT]),
        dirs: {
          [ROOT]: {
            status: "ok",
            items: [
              { name: "A.java", isDir: false, size: 100 },
              { name: "B.java", isDir: false, size: 100 },
            ],
          },
        },
        marks: {},
      },
    });
    loadBookmarks(ROOT);
    clearBookmarks();
    toggleBookmark(`${ROOT}\\A.java`, 12, "退款入口");
    await render();

    const marked = rowByName("A.java")!.querySelector(".wb-bookmark-mark");
    expect(marked).not.toBeNull();
    expect(marked!.getAttribute("title")).toContain("1 条书签");
    // 没有书签的文件不打点
    expect(rowByName("B.java")!.querySelector(".wb-bookmark-mark")).toBeNull();

    // 小旗跟着存储走：清空后同一行立即摘掉
    await act(async () => clearBookmarks());
    expect(rowByName("A.java")!.querySelector(".wb-bookmark-mark")).toBeNull();
  });
});

describe("文件树的右键操作", () => {

  it("目录右键可新建文件：输入名字回车后建文件并打开", async () => {
    await render();
    await rightClick(rowByName("modules")!);
    expect(menuItem("新建文件")).toBeTruthy();

    await click(menuItem("新建文件"));
    const input = container.querySelector<HTMLInputElement>(".wb-tree-edit-input");
    expect(input).toBeTruthy();

    await typeInto(input!, "A.java");
    await pressEnter(input!);

    expect(mocks.invoke).toHaveBeenCalledWith("fs_create", {
      parent: MODULES,
      name: "A.java",
      kind: "file",
    });
    expect(onCreated).toHaveBeenCalledWith(`${MODULES}\\A.java`);
    // 输入行收掉
    expect(container.querySelector(".wb-tree-edit-input")).toBeNull();
  });

  it("名字含非法字符时不发请求，错误就地显示", async () => {
    await render();
    await rightClick(rowByName("modules")!);
    await click(menuItem("新建文件"));

    const input = container.querySelector<HTMLInputElement>(".wb-tree-edit-input")!;
    await typeInto(input, "a/b.java");
    await pressEnter(input);

    expect(mocks.invoke).not.toHaveBeenCalledWith("fs_create", expect.anything());
    expect(container.querySelector(".wb-tree-edit-err")?.textContent).toContain("/");
    expect(container.querySelector(".wb-tree-edit-input")).toBeTruthy(); // 输入行还在，内容没丢
  });

  it("后端拒绝（重名）时把后端的文案显示出来", async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "fs_create") throw "已存在同名文件或文件夹";
      return [];
    });
    await render();
    await rightClick(rowByName("modules")!);
    await click(menuItem("新建文件"));

    const input = container.querySelector<HTMLInputElement>(".wb-tree-edit-input")!;
    await typeInto(input, "A.java");
    await pressEnter(input);

    expect(container.querySelector(".wb-tree-edit-err")?.textContent).toBe(
      "已存在同名文件或文件夹",
    );
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("重命名走 fs_rename，并把结果交给调用方改标签", async () => {
    await render();
    await rightClick(rowByName("readme.txt")!);
    await click(menuItem("重命名"));

    const input = container.querySelector<HTMLInputElement>(".wb-tree-edit-input")!;
    // 默认只选中主名，扩展名保留
    expect(input.value).toBe("readme.txt");
    await typeInto(input, "B.java");
    await pressEnter(input);

    expect(mocks.invoke).toHaveBeenCalledWith("fs_rename", {
      path: `${ROOT}\\readme.txt`,
      newName: "B.java",
    });
    expect(onRenamed).toHaveBeenCalledWith(`${ROOT}\\readme.txt`, `${ROOT}\\B.java`);
  });

  it("删除要先确认，确认后才真删", async () => {
    await render();
    await rightClick(rowByName("readme.txt")!);
    await click(menuItem("删除"));

    // 确认框里说清「不可撤销」
    expect(document.body.textContent).toContain("直接删除，不进回收站");
    expect(mocks.invoke).not.toHaveBeenCalledWith("fs_delete", expect.anything());

    const confirm = [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "删除" && b.closest('[role="dialog"]'),
    );
    await click(confirm);

    expect(mocks.invoke).toHaveBeenCalledWith("fs_delete", {
      path: `${ROOT}\\readme.txt`,
      recursive: false,
    });
    expect(onDeleted).toHaveBeenCalledWith([`${ROOT}\\readme.txt`]);
  });

  it("工作区根不允许重命名和删除", async () => {
    await render();
    // 根节点本身不占一行，在树的空白处右键就是针对根
    await rightClick(container.querySelector(".wb-tree-list")!);
    expect(menuItem("重命名")?.disabled).toBe(true);
    expect(menuItem("删除")?.disabled).toBe(true);
  });

  it("标题栏的新建按钮作用在当前选中项上", async () => {
    await render();
    // 没选中时建在根下
    await act(async () => treeRef.current?.startCreate("file"));
    const input = container.querySelector<HTMLInputElement>(".wb-tree-edit-input")!;
    await typeInto(input, "Top.java");
    await pressEnter(input);
    expect(mocks.invoke).toHaveBeenCalledWith("fs_create", {
      parent: ROOT,
      name: "Top.java",
      kind: "file",
    });
  });
});

describe("多工程树", () => {
  const OTHER = "C:\\w\\lib";
  const project = (name: string, root: string, origin: LinkedProject["origin"], depth: number): LinkedProject => ({
    name,
    root,
    origin,
    depth,
    exported: false,
    classDirs: [],
    disabled: false,
    hasClasspath: true,
  });
  const PROJECTS = [project("newar", ROOT, "primary", 0), project("lib", OTHER, "classpath", 1)];

  beforeEach(() => {
    setSession({
      tree: {
        root: ROOT,
        expanded: new Set([ROOT]),
        marks: {},
        dirs: {
          [ROOT]: { status: "ok", items: [{ name: "modules", isDir: true, size: 0 }] },
          [OTHER]: { status: "ok", items: [{ name: "Util.java", isDir: false, size: 10 }] },
        },
      },
    });
  });

  const projectRow = (name: string) =>
    [...container.querySelectorAll(".wb-row-project")].find(
      (el) => el.querySelector(".wb-row-name")?.textContent === name,
    );

  it("每个关联工程各占一行，当前工程带标记，展开依赖工程只动它自己", async () => {
    await render(null, PROJECTS);
    const current = projectRow("newar")!;
    const other = projectRow("lib")!;
    expect(current.getAttribute("data-current")).toBe("true");
    expect(other.getAttribute("data-current")).toBeNull();
    expect(current.getAttribute("aria-expanded")).toBe("true");
    expect(other.getAttribute("aria-expanded")).toBe("false");

    // 当前工程已展开，依赖工程默认收起
    expect(rowByExact("modules")).toBeTruthy();
    expect(rowByExact("Util.java")).toBeNull();

    await click(other);
    expect(rowByExact("Util.java")).toBeTruthy();
    // 目录已缓存，展开工程行不该再打一次 IPC
    expect(mocks.invoke).not.toHaveBeenCalledWith("fs_list_dir", { path: OTHER });
  });

  it("依赖工程的文件只读：菜单没有新建，改名 / 删除是禁用态", async () => {
    await render(null, PROJECTS);
    await click(projectRow("lib"));
    await rightClick(rowByExact("Util.java")!);

    expect(menuItem("新建文件")).toBeUndefined();
    expect(menuItem("新建文件夹")).toBeUndefined();
    expect(menuItem("重命名")?.disabled).toBe(true);
    expect(menuItem("删除")?.disabled).toBe(true);
    // 只读不挡「打开」「复制路径」这类不写盘的操作
    expect(menuItem("打开")?.disabled).toBe(false);
    expect(menuItem("复制路径")).toBeTruthy();
  });
});

describe("自动定位", () => {
  const FILE = `${MODULES}\\A.java`;
  const replyA = async (cmd: string) => {
    if (cmd === "fs_list_dir") return [{ name: "A.java", isDir: false, size: 10 }];
    if (cmd === "fs_encoding_marks") return [];
    return [];
  };
  /** 定位有 120ms 防抖，等它落地。 */
  const waitReveal = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 160));
    });

  it("默认开：切到某个文件就展开父目录并显示那一行", async () => {
    mocks.invoke.mockImplementation(replyA);
    await render(FILE);
    expect(rowByExact("A.java")).toBeNull();

    await waitReveal();
    expect(rowByExact("A.java")).toBeTruthy();
    expect(mocks.invoke).toHaveBeenCalledWith("fs_list_dir", { path: MODULES });
  });

  it("关掉后打开文件不再动树；显式「在文件树中显示」仍然有效", async () => {
    setRevealOnOpen(false);
    mocks.invoke.mockImplementation(replyA);
    await render(FILE);
    await waitReveal();

    expect(rowByExact("A.java")).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalledWith("fs_list_dir", { path: MODULES });

    await act(async () => {
      window.dispatchEvent(new CustomEvent("ncforge-reveal-in-tree", { detail: FILE }));
    });
    await waitReveal();
    expect(rowByExact("A.java")).toBeTruthy();
  });
});

describe("压缩中间包", () => {
  const COM = `${ROOT}\\com`;
  const AIER = `${COM}\\aier`;
  const ERP = `${AIER}\\erp`;
  const LISTING: Record<string, { name: string; isDir: boolean; size: number }[]> = {
    [ROOT]: [{ name: "com", isDir: true, size: 0 }],
    [COM]: [{ name: "aier", isDir: true, size: 0 }],
    [AIER]: [{ name: "erp", isDir: true, size: 0 }],
    [ERP]: [{ name: "Deep.java", isDir: false, size: 10 }],
  };

  const seedChain = () => {
    setSession({
      tree: {
        root: ROOT,
        expanded: new Set([ROOT]),
        marks: {},
        dirs: Object.fromEntries(
          Object.entries(LISTING).map(([p, items]) => [p, { status: "ok" as const, items }]),
        ),
      },
    });
    // 展开时会刷新链尾那一层，回同一份列表
    mocks.invoke.mockImplementation(async (cmd: string, args: { path?: string } = {}) => {
      if (cmd === "fs_list_dir") return LISTING[args.path ?? ""] ?? [];
      if (cmd === "fs_encoding_marks") return [];
      return [];
    });
  };

  it("单链合成一行，点一下把整条链展开到最里层", async () => {
    seedChain();
    await render();
    expect(rowByExact("com.aier.erp")).toBeTruthy();
    expect(rowByExact("aier")).toBeNull();

    await click(rowByExact("com.aier.erp"));
    expect(rowByExact("Deep.java")).toBeTruthy();
  });

  it("关掉开关后每层各占一行，点一次只展开这一层", async () => {
    setCompactPackages(false);
    seedChain();
    await render();
    expect(rowByExact("com.aier.erp")).toBeNull();
    expect(rowByExact("com")).toBeTruthy();
    expect(rowByExact("aier")).toBeNull();

    await click(rowByExact("com"));
    expect(rowByExact("aier")).toBeTruthy();
    expect(rowByExact("erp")).toBeNull();
  });
});

describe("外部改动自动刷新", () => {
  it("后端报某个已读过的目录变了，这一层重新读盘", async () => {
    setSession({ tree: { root: ROOT, expanded: new Set([ROOT]), dirs: {}, marks: {} } });
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "fs_list_dir") return [{ name: "external.java", isDir: false, size: 1 }];
      if (cmd === "fs_encoding_marks") return [];
      return [];
    });
    await render();
    await act(async () => {}); // 初始加载落回状态
    expect(rowByName("external.java")).toBeTruthy();

    // 外部工具换掉了文件：监听事件只报目录，前端得自己再读一次
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "fs_list_dir") return [{ name: "renamed.java", isDir: false, size: 1 }];
      if (cmd === "fs_encoding_marks") return [];
      return [];
    });
    expect(mocks.fsChanged.handler).toBeTruthy();
    await act(async () => {
      mocks.fsChanged.handler!({ dirs: [ROOT] });
    });

    expect(rowByName("renamed.java")).toBeTruthy();
    expect(rowByName("external.java")).toBeNull();
  });

  it("没读过的目录收到事件不会去打 IPC", async () => {
    await render();
    await act(async () => {});
    const before = mocks.invoke.mock.calls.filter(([cmd]) => cmd === "fs_list_dir").length;

    await act(async () => {
      mocks.fsChanged.handler!({ dirs: [`${ROOT}\never-opened`] });
    });

    const after = mocks.invoke.mock.calls.filter(([cmd]) => cmd === "fs_list_dir").length;
    expect(after).toBe(before);
  });

  // 平台丢了监听范围时后端只报 rescan、不报目录：没写进 dirs 的层也得重读，
  // 否则树的缓存会一直停在被外部工具改掉之前。
  it("rescan 时已读过的每一层都重读", async () => {
    setSession({
      tree: {
        root: ROOT,
        expanded: new Set([ROOT, MODULES]),
        marks: {},
        dirs: {
          [ROOT]: { status: "ok", items: [{ name: "modules", isDir: true, size: 0 }] },
          [MODULES]: { status: "ok", items: [] },
        },
      },
    });
    await render();
    await act(async () => {});
    mocks.invoke.mockClear();

    await act(async () => {
      mocks.fsChanged.handler!({ dirs: [], rescan: true });
    });

    const listed = mocks.invoke.mock.calls
      .filter(([cmd]) => cmd === "fs_list_dir")
      .map(([, args]) => (args as { path: string }).path)
      .sort();
    expect(listed).toEqual([ROOT, MODULES].sort());
  });
});
