// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileTree, type FileTreeHandle } from "./FileTree";
import { setSession } from "../../lib/workspaceSession";
import {
  setCompactPackages,
  setNcStructure,
  setRevealOnOpen,
} from "../../lib/treeViewPrefs";
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
const onCompileModule = vi.fn();
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
          onCompileModule={onCompileModule}
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
  setNcStructure(false);
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
    // 默认没有 manifest：徽章用例自己覆盖
    if (cmd === "nc_manifest") return { components: [], notes: [] };
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

  /**
   * 编译项：标出模块名，点它编的是**这一行**所属的模块。
   *
   * 它和标签栏那个「编译当前模块」不是一回事：那个取活动文件所在模块，
   * 批量替换改完 `gl` 之后活动文件常常在别的模块里，点它会静默编错模块。
   */
  it("模块右键能直接编译这个模块，且不依赖活动标签", async () => {
    // 活动标签故意指向另一个模块的文件：右键的模块必须照旧是 modules
    await render(`${MODULES}\\A.java`);
    await rightClick(rowByName("modules")!);

    const item = menuItem("编译模块");
    expect(item?.textContent).toContain("编译模块 modules");
    await click(item);
    expect(onCompileModule).toHaveBeenCalledWith(MODULES);
  });

  it("工作区根没有编译项（根不是一个模块）", async () => {
    await render();
    await rightClick(container.querySelector(".wb-tree-list")!);
    expect(menuItem("编译模块")).toBeUndefined();
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
    // 编译也没有：它不是只读问题，是「关联工程不属于当前工作区的编译范围」，后端必拒
    expect(menuItem("编译模块")).toBeUndefined();
  });

  /**
   * 多工程树里徽章与 NC 结构视图按**各自工程**的 manifest 生效。
   *
   * 回归点：徽章以前看 `depth === 0`，多工程树的模块行在 depth=1（工程行占了 0），
   * 关联工程的模块一次都没亮过；`isBcModule` 改成「父目录是某个工程根」后这里盯住。
   */
  it("关联工程的模块也带 BC 徽章，NC 结构视图摊的是它的 src", async () => {
    const LIB_BILL = `${OTHER}\\bill`;
    const LIB_SRC = `${LIB_BILL}\\src`;
    const LIB_PUBLIC = `${LIB_SRC}\\public`;
    const LISTING: Record<string, { name: string; isDir: boolean; size: number }[]> = {
      [ROOT]: [{ name: "modules", isDir: true, size: 0 }],
      [OTHER]: [
        { name: "bill", isDir: true, size: 0 },
        { name: "util", isDir: true, size: 0 },
      ],
      [LIB_BILL]: [
        { name: "src", isDir: true, size: 0 },
        { name: "resources", isDir: true, size: 0 },
      ],
      [LIB_SRC]: [
        { name: "public", isDir: true, size: 0 },
        { name: "client", isDir: true, size: 0 },
      ],
      [LIB_PUBLIC]: [{ name: "U.java", isDir: false, size: 8 }],
    };
    setSession({
      tree: {
        root: ROOT,
        expanded: new Set([ROOT, OTHER]),
        marks: {},
        dirs: Object.fromEntries(
          Object.entries(LISTING).map(([p, items]) => [p, { status: "ok" as const, items }]),
        ),
      },
    });
    mocks.invoke.mockImplementation(async (cmd: string, args: { root?: string; path?: string } = {}) => {
      if (cmd === "nc_manifest") {
        // 当前工作区没有 manifest；关联工程登记了 bill
        if (args.root === OTHER) {
          return {
            components: [{ name: "bill", dispname: "票据", roots: ["src/public"] }],
            notes: [],
          };
        }
        throw new Error("读取 manifest.xml 失败: 系统找不到指定的文件");
      }
      // 展开时会重列一次已缓存的层，得按真实内容回，不能回空
      if (cmd === "fs_list_dir") return LISTING[args.path ?? ""] ?? [];
      if (cmd === "fs_encoding_marks") return [];
      return [];
    });
    setNcStructure(true);
    await render(null, PROJECTS);
    await act(async () => {}); // 等两个工程的 manifest 落地

    // 徽章跟工程走：关联工程的 bill 有，当前工作区的 modules、没登记的 util 没有
    const badge = rowByExact("bill")!.querySelector(".wb-bc-badge");
    expect(badge?.textContent).toBe("BC");
    expect(badge?.getAttribute("title")).toContain("票据");
    expect(rowByExact("modules")!.querySelector(".wb-bc-badge")).toBeNull();
    expect(rowByExact("util")!.querySelector(".wb-bc-badge")).toBeNull();

    // 摊平的也是关联工程那一份 src：展开 bill 直接看到源码根，行带真实路径
    await click(rowByExact("bill"));
    expect(rowByExact("src")).toBeNull();
    const pub = rowByExact("public")!;
    expect(pub.getAttribute("id")).toContain(encodeURIComponent(LIB_PUBLIC));
    await click(pub);
    expect(rowByExact("U.java")).toBeTruthy();
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

/**
 * `manifest.xml` 的业务组件徽章。
 *
 * 盯两件事：① 徽章只按「工程根下这一层」判断，包的子目录里出现同名目录不能误标
 * （`com/…/bill` 不是业务组件）；② manifest 读不到时树照常显示，不弹错、不空树。
 */
describe("业务组件徽章", () => {
  it("根下登记过的模块带 BC，未登记的不带；更深的同名目录不算", async () => {
    setSession({
      tree: {
        root: ROOT,
        expanded: new Set([ROOT, `${ROOT}\\gl`]),
        marks: {},
        dirs: {
          [ROOT]: {
            status: "ok",
            items: [
              { name: "bill", isDir: true, size: 0 },
              { name: "gl", isDir: true, size: 0 },
            ],
          },
          // gl 下放两个子目录避开压缩链，才能看到 depth=1 的 bill 行
          [`${ROOT}\\gl`]: {
            status: "ok",
            items: [
              { name: "bill", isDir: true, size: 0 },
              { name: "src", isDir: true, size: 0 },
            ],
          },
        },
      },
    });
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "nc_manifest") {
        return { components: [{ name: "bill", dispname: "票据", roots: ["src/public"] }], notes: [] };
      }
      if (cmd === "fs_list_dir" || cmd === "fs_encoding_marks") return [];
      throw new Error(`unexpected command: ${cmd}`);
    });
    await render();
    await act(async () => {}); // 等 manifest 那次 invoke 落地

    const bills = [...container.querySelectorAll(".wb-row")].filter(
      (el) => el.querySelector(".wb-row-name")?.textContent === "bill",
    );
    expect(bills).toHaveLength(2);
    const badge = bills[0].querySelector(".wb-bc-badge");
    expect(badge?.textContent).toBe("BC");
    expect(badge?.getAttribute("title")).toContain("票据");
    expect(bills[1].querySelector(".wb-bc-badge")).toBeNull();

    const gl = rowByExact("gl")!;
    expect(gl.querySelector(".wb-bc-badge")).toBeNull();
  });

  it("manifest 读不到时树照常渲染，只是一个徽章都没有", async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "nc_manifest") throw new Error("读取 manifest.xml 失败: 系统找不到指定的文件");
      if (cmd === "fs_list_dir" || cmd === "fs_encoding_marks") return [];
      throw new Error(`unexpected command: ${cmd}`);
    });
    await render();
    await act(async () => {});

    expect(container.querySelectorAll(".wb-row").length).toBeGreaterThan(0);
    expect(container.querySelectorAll(".wb-bc-badge")).toHaveLength(0);
    expect(mocks.toast).not.toHaveBeenCalled();
  });
});

/**
 * NC 结构视图：业务组件模块的 `src` 摊平。
 *
 * 盯四件事：
 * ① 开着时展开 `bill` 第一层直接是 public/client/private/test/resources，没有 `src`；
 * ② 摊平后的行**仍是真实磁盘路径**（`bill/src/public`），不引入虚拟节点；
 * ③ 关掉时 `src` 回来，逐层显示；
 * ④ `reveal` 定位 `bill/src/public/x.java` 在两种开关下都能滚到那一行；
 *    没登记在 manifest 里的模块（`aim`）两种开关下都照普通目录展开。
 */
describe("NC 结构视图", () => {
  const BILL = `${ROOT}\\bill`;
  const AIM = `${ROOT}\\aim`;
  const BILL_SRC = `${BILL}\\src`;
  const BILL_PUBLIC = `${BILL_SRC}\\public`;
  const LISTING: Record<string, { name: string; isDir: boolean; size: number }[]> = {
    [ROOT]: [
      { name: "bill", isDir: true, size: 0 },
      { name: "aim", isDir: true, size: 0 },
    ],
    [BILL]: [
      { name: "src", isDir: true, size: 0 },
      { name: "resources", isDir: true, size: 0 },
      { name: "META-INF", isDir: true, size: 0 },
    ],
    [BILL_SRC]: [
      { name: "public", isDir: true, size: 0 },
      { name: "client", isDir: true, size: 0 },
      { name: "private", isDir: true, size: 0 },
      { name: "test", isDir: true, size: 0 },
    ],
    [BILL_PUBLIC]: [{ name: "x.java", isDir: false, size: 12 }],
    // aim 也放两个子目录：只有一个的话会被「压缩中间包」并成 `aim.src` 一行，
    // 行名就不是 `aim` 了（那是压缩链的行为，不是本用例要测的东西）
    [AIM]: [
      { name: "src", isDir: true, size: 0 },
      { name: "lib", isDir: true, size: 0 },
    ],
    // 两个子目录：一个的话 `aim/src` 也会被并进压缩链里
    [`${AIM}\\src`]: [
      { name: "main", isDir: true, size: 0 },
      { name: "gen", isDir: true, size: 0 },
    ],
  };

  const seed = () => {
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
    mocks.invoke.mockImplementation(async (cmd: string, args: { path?: string } = {}) => {
      if (cmd === "nc_manifest") {
        return {
          components: [{ name: "bill", dispname: "票据", roots: ["src/public", "src/client"] }],
          notes: [],
        };
      }
      if (cmd === "fs_list_dir") return LISTING[args.path ?? ""] ?? [];
      if (cmd === "fs_encoding_marks") return [];
      return [];
    });
  };

  it("开着：展开 bill 直接看到 5 个源码根，没有 src 这一层", async () => {
    setNcStructure(true);
    seed();
    await render();
    await act(async () => {}); // 等 manifest 落地
    await click(rowByExact("bill"));

    expect(rowByExact("src")).toBeNull();
    expect(rowByExact("public")).toBeTruthy();
    for (const n of ["client", "private", "test", "resources", "META-INF"]) {
      expect(rowByExact(n)).toBeTruthy();
    }
    // 摊平后的行带的是真实路径：父目录是 bill/src，不是虚拟节点
    const pub = rowByExact("public")!;
    expect(pub.getAttribute("id")).toContain(encodeURIComponent(BILL_PUBLIC));
    await click(pub);
    expect(rowByExact("x.java")).toBeTruthy();
  });

  it("关掉：src 自己占一行，要点两下才到源码根", async () => {
    setNcStructure(false);
    seed();
    await render();
    await act(async () => {});
    await click(rowByExact("bill"));

    expect(rowByExact("src")).toBeTruthy();
    expect(rowByExact("public")).toBeNull();
    await click(rowByExact("src"));
    expect(rowByExact("public")).toBeTruthy();
  });

  /**
   * 定位有 120ms 防抖，等它落地。
   *
   * 每个开关单独一条用例：在一条用例里来回切开关，组件不重挂，`useTreeLocate`
   * 的 effect 依赖没变就不会再跑一次定位——那是测试自己的坑，不是产品的。
   */
  const waitReveal = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 160));
    });

  it("开着：定位 bill/src/public/x.java 能滚到那一行（public 是展开态）", async () => {
    setNcStructure(true);
    seed();
    await render(`${BILL_PUBLIC}\\x.java`);
    await waitReveal();

    expect(rowByExact("x.java")).toBeTruthy();
    // 定位是顺着真实路径逐层展开的：摊平后 public 这一行必须真的是展开态
    expect(rowByExact("public")!.getAttribute("aria-expanded")).toBe("true");
  });

  it("关掉：定位同一个文件照样能滚到那一行", async () => {
    setNcStructure(false);
    seed();
    await render(`${BILL_PUBLIC}\\x.java`);
    await waitReveal();

    expect(rowByExact("src")).toBeTruthy();
    expect(rowByExact("x.java")).toBeTruthy();
    expect(rowByExact("public")!.getAttribute("aria-expanded")).toBe("true");
  });

  it("没登记在 manifest 里的 aim：开着 NC 结构视图也按普通目录展开", async () => {
    setNcStructure(true);
    seed();
    await render();
    await act(async () => {});
    await click(rowByExact("aim"));

    expect(rowByExact("src")).toBeTruthy();
    await click(rowByExact("src"));
    expect(rowByExact("main")).toBeTruthy();
  });
});
