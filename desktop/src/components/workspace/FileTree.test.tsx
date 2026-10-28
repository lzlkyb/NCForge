// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileTree, type FileTreeHandle } from "./FileTree";
import { setSession } from "../../lib/workspaceSession";
import { ViewActivityContext } from "../../lib/viewActivity";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), toast: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));
vi.mock("../ui/toast", () => ({ toast: mocks.toast }));
vi.mock("../../hooks/usePrefersReducedMotion", () => ({
  usePrefersReducedMotion: () => true,
}));
// workspaceSession 会拉起 editorStore，editorStore 又拉起 monaco；jsdom 里 monaco 初始化就挂
vi.mock("../../lib/editorStore", () => ({ onDirtyChange: () => () => {} }));

const ROOT = "C:\\w\\newar";
const MODULES = `${ROOT}\\modules`;

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
const onOpen = vi.fn();
const onCreated = vi.fn();
const onRenamed = vi.fn();
const onDeleted = vi.fn();
const treeRef = createRef<FileTreeHandle>();

const render = async () => {
  await act(async () =>
    root.render(
      <ViewActivityContext.Provider value={true}>
        <FileTree
          ref={treeRef}
          root={ROOT}
          activePath={null}
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
