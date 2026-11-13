// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TreeSvnContext } from "./TreeSvnContext";
import { pathKey } from "../../lib/treeSvn";
import { FileTree, type FileTreeHandle } from "./FileTree";
import { getSession, setSession } from "../../lib/workspaceSession";
import {
  setCompactPackages,
  setNcStructure,
  setPackageView,
  setRevealOnOpen,
} from "../../lib/treeViewPrefs";
import { ViewActivityContext } from "../../lib/viewActivity";
import { clearBookmarks, loadBookmarks, toggleBookmark } from "../../lib/bookmarks";
import type { LinkedProject } from "../../lib/linkedProjects";
import type { CompileResult } from "../../lib/compile";
import { setCodeDiags } from "../../lib/diagStore";

const mocks = vi.hoisted(() => {
  const fsChanged: {
    handler: ((p: { dirs?: string[]; rescan?: boolean }) => void) | null;
  } = { handler: null };
  return { invoke: vi.fn(), toast: vi.fn(), fsChanged, modelText: vi.fn() };
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
vi.mock("../../lib/editorStore", () => ({
  getModel: () => undefined,
  getText: mocks.modelText,
  onModelLifecycle: () => () => {},
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

const render = async (activePath: string | null = null, projects?: LinkedProject[], svn = { files: new Map(), directories: new Map(), summary: null }) => {
  await act(async () =>
    root.render(
      <ViewActivityContext.Provider value={true}>
        <TreeSvnContext.Provider value={svn}>
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
        </TreeSvnContext.Provider>
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
  setCodeDiags([]);
  setCompactPackages(true);
  setRevealOnOpen(true);
  setNcStructure(false);
  setPackageView(false);
  // 预置一棵已展开的树，免得每次渲染都去 listDir
  setSession({
    compileResult: null,
    problemsPath: null,
    problemsPathScope: undefined,
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

it("只看改动保留父目录，退出后恢复展开状态和滚动位置", async () => {
  const name = "changed.txt";
  const invoke = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation(async (cmd, args) =>
    cmd === "fs_list_dir" && args?.path === MODULES
      ? [{ name, isDir: false, size: 1 }]
      : invoke(cmd, args),
  );
  await render(null, undefined, {
    files: new Map([[pathKey(MODULES + "/" + name), "M"]]),
    directories: new Map([[pathKey(ROOT), 1], [pathKey(MODULES), 1]]),
    summary: null,
  });
  const list = container.querySelector<HTMLElement>('[role="tree"]')!;
  const toggle = [...container.querySelectorAll("button")].find(button => button.textContent?.includes("只看改动"));
  list.scrollTop = 90;
  await click(toggle);
  expect(rowByExact("readme.txt")).toBeNull();
  expect(rowByExact("modules")).toBeTruthy();
  await click(rowByExact("modules"));
  expect(rowByExact(name)).toBeTruthy();
  expect(getSession().tree.expanded.has(MODULES)).toBe(false);
  list.scrollTop = 0;
  await click(toggle);
  expect(rowByExact("readme.txt")).toBeTruthy();
  expect(rowByExact(name)).toBeNull();
  expect(list.scrollTop).toBe(90);
});

describe("树目录文件类型", () => {
  it("NC 文件用后缀徽标，并保留真实文件名后缀", async () => {
    const files = ["CustomerLookupEndpointDeclaration.REST", "meta.upm", "meta.aop", "meta.bmf", "meta.bpf"];
    setSession({ tree: {
      root: ROOT, expanded: new Set([ROOT]), marks: {},
      dirs: { [ROOT]: { status: "ok", items: files.map(name => ({ name, isDir: false, size: 10 })) } },
    } });
    await render();
    const rows = files.map(rowByExact);
    expect(rows.map(row => row?.getAttribute("data-kind"))).toEqual(["rest", "upm", "aop", "bmf", "bpf"]);
    expect(rows.map(row => row?.querySelector(".wb-tree-type-badge")?.textContent)).toEqual(["REST", "UPM", "AOP", "BMF", "BPF"]);
    expect(rows[0]?.getAttribute("aria-label")).toBe(files[0]);
    expect(rows[0]?.getAttribute("aria-description")).toBe("NC REST 声明");
    expect(rows[0]?.querySelector(".wb-tree-type svg")).toBeNull();
    expect(rows[0]?.querySelector(".wb-file-ext")?.textContent).toBe(".REST");
    await click(rows[0]);
    expect(onOpen).toHaveBeenCalledWith(`${ROOT}\\${files[0]}`);
  });

  it("文件先出现，按目录批量补齐 Java 类型并保留文件打开路径", async () => {
    const names = ["Demo.java", "Service.java", "Mode.java", "Tag.java", "Pair.java", "Mixed.java", "data.xml", "query.sql", "meta.bmf", "lib.jar"];
    setSession({ tree: {
      root: ROOT, expanded: new Set([ROOT]), marks: {},
      dirs: { [ROOT]: { status: "ok", items: names.map(name => ({ name, isDir: false, size: 10 })) } },
    } });
    const original = mocks.invoke.getMockImplementation()!;
    let resolveKinds: (value: Record<string, string>) => void = () => {};
    mocks.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "fs_java_kinds") return new Promise<Record<string, string>>(resolve => { resolveKinds = resolve; });
      return original(cmd, args);
    });
    await render();
    expect(rowByExact("Service.java")?.getAttribute("data-kind")).toBe("java");
    expect(rowByExact("data.xml")?.getAttribute("data-kind")).toBe("xml");
    expect(rowByExact("query.sql")?.getAttribute("data-kind")).toBe("sql");
    expect(rowByExact("meta.bmf")?.getAttribute("data-kind")).toBe("bmf");
    expect(rowByExact("lib.jar")?.getAttribute("data-kind")).toBe("archive");
    expect(mocks.invoke).toHaveBeenCalledWith("fs_java_kinds", { path: ROOT, names: names.slice(0, 6) });
    await act(async () => resolveKinds({ "Demo.java": "class", "Service.java": "interface", "Mode.java": "enum", "Tag.java": "annotation", "Pair.java": "record" }));
    expect(names.slice(0, 6).map(name => rowByExact(name)?.getAttribute("data-kind"))).toEqual([
      "java-class", "java-interface", "java-enum", "java-annotation", "java-record", "java",
    ]);
    expect(names.slice(0, 6).map(name => rowByExact(name)?.querySelector(".wb-tree-type-badge")?.textContent)).toEqual([
      "类", "接口", "枚举", "注解", "Record", "Java",
    ]);
    expect(rowByExact("data.xml")?.querySelector(".wb-tree-type svg")).not.toBeNull();
    expect(rowByExact("Service.java")?.getAttribute("aria-description")).toBe("Java 接口");
    await click(rowByExact("Service.java"));
    expect(onOpen).toHaveBeenCalledWith(`${ROOT}\\Service.java`);
  });
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
      template: true,
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
      template: true,
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


describe("包资源管理器", () => {
  it("展开依赖库才读取工程依赖，并按已解析的附件定位源码", async () => {
    const original = mocks.invoke.getMockImplementation()!;
    const sourcePath = `${ROOT}\\sources.zip`;
    mocks.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "project_dependencies") return [
        { kind: "library", name: "present.jar", declared: "present.jar", status: "available", source: "sources.zip", sourcePath },
        { kind: "library", name: "missing.jar", declared: "missing.jar", status: "missing" },
      ];
      if (cmd === "reveal_dependency_source") return;
      return original(cmd, args);
    });
    setPackageView(true);
    await render();
    expect(mocks.invoke).not.toHaveBeenCalledWith("project_dependencies", expect.anything());
    await act(async () => {
      const panel = container.querySelector<HTMLDetailsElement>(".wb-dependencies")!;
      panel.open = true;
      panel.dispatchEvent(new Event("toggle"));
    });
    expect(mocks.invoke).toHaveBeenCalledWith("project_dependencies", { root: ROOT });
    expect(container.textContent).toContain("缺失 1 项");
    const locate = [...container.querySelectorAll("button")].find(b => b.textContent === "定位源码");
    await click(locate);
    expect(mocks.invoke).toHaveBeenCalledWith("reveal_dependency_source", { root: ROOT, path: sourcePath });
  });

  it("按需展开 Java 文件并用键盘跳转，成员不进入磁盘操作", async () => {
    const path = `${ROOT}\\Demo.java`;
    setSession({ tree: { root: ROOT, expanded: new Set([ROOT]), marks: {}, dirs: {
      [ROOT]: { status: "ok", items: [{ name: "Demo.java", isDir: false, size: 80 }] },
    } } });
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "fs_java_outline_source") return "class Demo {\n  private int count;\n  void run() {}\n}";
      return original(cmd, args);
    });
    setPackageView(true);
    await render();
    expect(mocks.invoke).not.toHaveBeenCalledWith("fs_java_outline_source", expect.anything());
    await click(rowByExact("Demo.java"));
    expect(onOpen).toHaveBeenCalledWith(path);
    const tree = container.querySelector('[role="tree"]')!;
    const key = (name: string) => act(async () => tree.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })));
    await key("ArrowRight");
    expect(rowByExact("Demo")?.querySelector(".wb-tree-type-badge")?.textContent).toBe("类");
    expect(rowByExact("count")?.getAttribute("aria-description")).toContain("字段");
    await key("ArrowRight");
    await key("ArrowRight");
    await key("ArrowDown");
    await key("Enter");
    expect(onOpen).toHaveBeenLastCalledWith(path, { line: 3, column: 8 });
    await key("F2");
    await key("Delete");
    expect(container.querySelector(".wb-tree-edit")).toBeNull();
    expect(mocks.invoke.mock.calls.some(call => call[0] === "fs_delete")).toBe(false);
    await click(rowByExact("Demo.java")!.querySelector(".wb-file-disclosure"));
    expect(rowByExact("run()")).toBeNull();
    mocks.modelText.mockReturnValueOnce("class Demo { void unsaved() {} }");
    await click(rowByExact("Demo.java")!.querySelector(".wb-file-disclosure"));
    expect(rowByExact("unsaved()")).toBeTruthy();
    expect(mocks.invoke.mock.calls.filter(call => call[0] === "fs_java_outline_source")).toHaveLength(1);
  });

  it("完整包名同级展示，展开和定位无需打开前缀目录", async () => {
    const source = `${ROOT}\\src`;
    const parent = `${source}\\nccloud\\itf\\eye\\portal`;
    const child = `${parent}\\factory`;
    const folder = (name: string) => ({ name, isDir: true, size: 0 });
    const file = (name: string) => ({ name, isDir: false, size: 1 });
    const indexed = [
      { relative: "nccloud/itf/eye/portal", isPackage: true },
      { relative: "nccloud/itf/eye/portal/factory", isPackage: true },
    ];
    const dirs: Record<string, unknown[]> = {
      [ROOT]: [folder("src")], [source]: [folder("nccloud")],
      [parent]: [folder("factory"), file("Parent.properties")], [child]: [file("Factory.java")],
    };
    setSession({ tree: { root: ROOT, dirs: { [ROOT]: { status: "ok", items: [folder("src")] } }, expanded: new Set([ROOT]), marks: {} } });
    mocks.invoke.mockImplementation(async (cmd: string, args: { path?: string }) => {
      if (cmd === "fs_read_file") return { text: '<classpath><classpathentry kind="src" path="src"/></classpath>' };
      if (cmd === "nc_manifest") return { components: [] };
      if (cmd === "fs_list_dir") return dirs[args.path!] ?? [];
      if (cmd === "fs_package_dirs") return [...indexed];
      if (cmd === "fs_encoding_marks") return [];
      throw new Error(cmd);
    });
    setPackageView(true);
    await render();
    expect(mocks.invoke).not.toHaveBeenCalledWith("fs_package_dirs", expect.anything());
    await click(rowByExact("src"));
    const parentRow = rowByExact("nccloud.itf.eye.portal")!;
    const childRow = rowByExact("nccloud.itf.eye.portal.factory")!;
    expect(parentRow.getAttribute("aria-level")).toBe(childRow.getAttribute("aria-level"));
    await click(parentRow);
    expect(rowByExact("Parent.properties")).toBeTruthy();
    expect(rowByExact("factory")).toBeNull();
    await act(async () => window.dispatchEvent(new CustomEvent("ncforge-reveal-in-tree", { detail: `${child}\\Factory.java` })));
    expect(rowByExact("Factory.java")).toBeTruthy();
    expect(mocks.invoke).not.toHaveBeenCalledWith("fs_list_dir", { path: `${source}\\nccloud` });
    await click(rowByExact("Factory.java"));
    expect(onOpen).toHaveBeenCalledWith(`${child}\\Factory.java`);
    const tree = container.querySelector('[role="tree"]')!;
    await act(async () => tree.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(document.getElementById(tree.getAttribute("aria-activedescendant")!)?.textContent).toBe("nccloud.itf.eye.portal.factory");
    indexed.push({ relative: "nccloud/itf/eye/portal/page", isPackage: true });
    await act(async () => {
      mocks.fsChanged.handler?.({ dirs: [parent] });
      await new Promise(resolve => setTimeout(resolve, 220));
    });
    expect(rowByExact("nccloud.itf.eye.portal.page")).toBeTruthy();
  });

  it("平铺已验证的源码根，按需打开真实路径，切换后可从原目录访问", async () => {
    const j = (...parts: string[]) => [ROOT, ...parts].join("\\");
    const src = j("Bill", "src", "private");
    const file = `${src}\\A.java`;
    const dir = (name: string) => ({ name, isDir: true, size: 0 });
    const listings: Record<string, unknown[]> = {
      [ROOT]: [dir("Bill")], [j("Bill")]: [dir("src"), dir("resources")],
      [j("Bill", "src")]: [dir("private"), dir("public")],
      [src]: [{ name: "A.java", isDir: false, size: 1 }],
    };
    setSession({ tree: { root: ROOT, dirs: { [ROOT]: { status: "ok", items: [dir("Bill")] } }, expanded: new Set([ROOT]), marks: {} } });
    mocks.invoke.mockImplementation(async (cmd: string, args: { path?: string }) => {
      if (cmd === "fs_read_file") return { text: '<classpath><classpathentry kind="src" path="bill/src/private"/><classpathentry kind="src" path="/Other"/><classpathentry kind="src" path="Bill/src/missing"/></classpath>' };
      if (cmd === "nc_manifest") return { components: [{ name: "bill", dispname: "", roots: [] }], notes: [] };
      if (cmd === "fs_list_dir") return listings[args.path!] ?? [];
      if (cmd === "fs_encoding_marks") return [];
      throw new Error(cmd);
    });
    setPackageView(true);
    await render();
    const tree = container.querySelector('[role="tree"]')!;
    expect(tree.getAttribute("aria-label")).toBe("包资源管理器");
    expect(rowByExact("Bill/src/private")?.getAttribute("aria-level")).toBe("2");
    expect([...tree.querySelectorAll(".wb-row-name")].slice(1, 4).map(r => r.textContent)).toEqual(["Bill/src/public", "Bill/src/private", "Bill/resources"]);
    expect(mocks.invoke).not.toHaveBeenCalledWith("fs_list_dir", { path: src });
    await click(rowByExact("Bill/src/private"));
    await click(rowByExact("A.java"));
    expect(onOpen).toHaveBeenCalledWith(file);
    await act(async () => tree.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(document.getElementById(tree.getAttribute("aria-activedescendant")!)?.textContent).toContain("Bill/src/private");
    await click(rowByExact("Bill/src/private"));
    await act(async () => window.dispatchEvent(new CustomEvent("ncforge-reveal-in-tree", { detail: file })));
    expect(rowByExact("A.java")).toBeTruthy();
    expect(rowByExact("private")).toBeNull();
    await act(async () => setPackageView(false));
    expect(rowByExact("Bill/src/private")).toBeNull();
    expect(rowByExact("A.java")).toBeTruthy();
  });
});

describe("编译问题标记", () => {
  it("折叠包和模块只显示严重度，文件显示去重计数，徽标可按范围打开面板", async () => {
    setCompactPackages(false);
    const mod = `${ROOT}\\modules`;
    const pkg = `${mod}\\p`;
    const result: CompileResult = {
      ok: false,
      durationMs: 0,
      sourceCount: 2,
      errorCount: 1,
      warningCount: 1,
      problems: [
        { severity: "error", file: `${pkg}\\A.java`, line: 1, message: "x" },
        { severity: "warning", file: `${pkg}\\B.java`, line: 2, message: "y" },
      ],
      jarCount: 0,
      rounds: 1,
      outDir: "",
      diagnostics: [],
      modules: [],
    };
    setSession({
      root: ROOT,
      compileResult: result,
      tree: {
        root: ROOT,
        expanded: new Set([ROOT, mod, pkg]),
        marks: {},
        dirs: {
          [ROOT]: { status: "ok", items: [{ name: "modules", isDir: true, size: 0 }] },
          [mod]: { status: "ok", items: [{ name: "p", isDir: true, size: 0 }] },
          [pkg]: {
            status: "ok",
            items: [
              { name: "A.java", isDir: false, size: 1 },
              { name: "B.java", isDir: false, size: 1 },
            ],
          },
        },
      },
    });
    await act(async () => setCodeDiags([
      { path: (pkg + "\\A.java").replace(/\\/g, "/").toUpperCase(), line: 1, column: 9, severity: "error", message: "x" },
    ]));
    await render();
    const badge = (name: string) =>
      rowByExact(name)?.querySelector(".wb-problem-badge") ?? null;
    expect(badge("modules")?.textContent).toBe("");
    expect(badge("modules")?.getAttribute("title")).toContain("1 个错误 · 1 个警告");
    expect(badge("p")?.getAttribute("data-sev")).toBe("error");
    expect(rowByExact("A.java")?.querySelectorAll(".wb-problem-badge")).toHaveLength(1);
    expect(badge("A.java")?.getAttribute("title")).toContain("实时检查 1 条 · 最近编译 1 条");
    expect(badge("A.java")?.textContent).toBe("1");
    expect(badge("A.java")?.getAttribute("data-sev")).toBe("error");
    expect(badge("B.java")?.textContent).toBe("1");
    expect(badge("B.java")?.getAttribute("data-sev")).toBe("warning");
    expect(badge("B.java")?.getAttribute("title")).toContain("1 个警告");
    await click(rowByExact("p"));
    expect(rowByExact("A.java")).toBeNull();
    await click(badge("p"));
    expect(getSession()).toMatchObject({ problemsPath: pkg, problemsPathScope: "branch", panelTab: "problems" });
    expect(rowByExact("p")?.getAttribute("aria-expanded")).toBe("false");
    mocks.invoke.mockResolvedValueOnce([{ name: "A.java", isDir: false, size: 1 }, { name: "B.java", isDir: false, size: 1 }]);
    await click(rowByExact("p"));
    await click(badge("A.java"));
    expect(getSession()).toMatchObject({ problemsPath: pkg + "\\A.java", problemsPathScope: "file" });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("右键文件可把问题面板过滤到该文件", async () => {
    setCompactPackages(false);
    const mod = `${ROOT}\\modules`;
    const pkg = `${mod}\\p`;
    const file = `${pkg}\\A.java`;
    const result: CompileResult = {
      ok: false,
      durationMs: 0,
      sourceCount: 1,
      errorCount: 1,
      warningCount: 0,
      problems: [{ severity: "error", file, line: 1, message: "x" }],
      jarCount: 0,
      rounds: 1,
      outDir: "",
      diagnostics: [],
      modules: [],
    };
    setSession({
      root: ROOT,
      compileResult: result,
      tree: {
        root: ROOT,
        expanded: new Set([ROOT, mod, pkg]),
        marks: {},
        dirs: {
          [ROOT]: { status: "ok", items: [{ name: "modules", isDir: true, size: 0 }] },
          [mod]: { status: "ok", items: [{ name: "p", isDir: true, size: 0 }] },
          [pkg]: { status: "ok", items: [{ name: "A.java", isDir: false, size: 1 }] },
        },
      },
    });
    await render();
    await rightClick(rowByExact("A.java")!);
    const item = menuItem("查看该文件的 1 个问题");
    expect(item).toBeTruthy();
    await click(item);
    expect(getSession().problemsPath).toBe(file);
    expect(getSession().panelTab).toBe("problems");
    expect(getSession().panelOpen).toBe(true);
  });

  it("只看问题保留父级，退出后恢复展开；提示不产生树徽标", async () => {
    setCompactPackages(false);
    const mod = `${ROOT}\\modules`;
    const pkg = `${mod}\\p`;
    setCodeDiags([
      { path: `${pkg}\\A.java`, line: 1, column: 1, severity: "warning", message: "未使用" },
    ]);
    setSession({
      root: ROOT,
      tree: {
        root: ROOT,
        expanded: new Set([ROOT, mod, pkg]),
        marks: {},
        dirs: {
          [ROOT]: { status: "ok", items: [{ name: "modules", isDir: true, size: 0 }] },
          [mod]: { status: "ok", items: [{ name: "p", isDir: true, size: 0 }] },
          [pkg]: { status: "ok", items: [{ name: "A.java", isDir: false, size: 1 }] },
        },
      },
    });
    const expandBefore = new Set([ROOT, mod]);
    setSession({ tree: { ...getSession().tree, expanded: expandBefore } });
    await render();
    const toggle = container.querySelector(".wb-tree-problem-tools button");
    await click(toggle);
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
    expect(rowByExact("p")).toBeTruthy();
    mocks.invoke.mockResolvedValueOnce([{ name: "A.java", isDir: false, size: 1 }]);
    await click(rowByExact("p"));
    const badge = rowByExact("A.java")?.querySelector('.wb-problem-badge[data-sev="warning"]');
    expect(badge?.textContent).toBe("1");
    expect(badge?.getAttribute("title")).toContain("实时检查 1 条");
    expect(getSession().tree.expanded).toEqual(expandBefore);
    await act(async () => setCodeDiags([
      { path: pkg + "\\A.java", line: 1, column: 1, severity: "info", message: "建议" },
    ]));
    expect(container.textContent).toContain("当前没有已报告的错误或警告");
    expect(container.querySelector(".wb-problem-badge")).toBeNull();
    await click(toggle);
    expect(rowByExact("p")?.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("树键盘导航", () => {
  const treeEl = () => container.querySelector<HTMLElement>('[role="tree"]')!;
  const key = async (name: string) =>
    act(async () => treeEl().dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })));
  const editInput = () => container.querySelector<HTMLInputElement>(".wb-tree-edit input");

  it("点目录行就是选中它，F2 改名落在这一行而不是上一次选中的文件", async () => {
    await render();
    await click(rowByExact("readme.txt"));
    expect(onOpen).toHaveBeenCalledWith(`${ROOT}\\readme.txt`);
    await click(rowByExact("modules"));
    await key("F2");
    // 不更新 selected 的话这里会变成 readme.txt —— 用户点的是目录，改的却是文件
    expect(editInput()?.value).toBe("modules");
  });

  it("编辑态下 Escape 能取消，方向键不穿透到树", async () => {
    await render();
    await act(async () => treeRef.current!.startCreate("file"));
    expect(editInput()).toBeTruthy();
    await key("ArrowDown");
    expect(treeEl().getAttribute("aria-activedescendant")).toBeNull();
    await key("Escape");
    expect(editInput()).toBeNull();
  });

  it("树上打字进筛选条但不抢焦点，方向键仍然驱动树", async () => {
    await render();
    treeEl().focus();
    await key("r");
    const box = container.querySelector<HTMLInputElement>(".wb-tree-quick-filter input");
    expect(box?.value).toBe("r");
    // 抢走焦点就等于把整棵树的键盘导航关掉：↑↓ 会落到输入框里
    expect(document.activeElement).toBe(treeEl());
    await key("ArrowDown");
    expect(document.getElementById(treeEl().getAttribute("aria-activedescendant")!)).toBe(rowByExact("readme.txt"));
    // Escape 第一下清词（条还留着好继续打），第二下把它收掉
    await key("Escape");
    expect(box?.value).toBe("");
    await key("Escape");
    expect(container.querySelector(".wb-tree-quick-filter")).toBeNull();
  });
});
