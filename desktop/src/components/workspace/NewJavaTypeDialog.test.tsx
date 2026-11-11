// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewJavaTypeDialog, guessKind } from "./NewJavaTypeDialog";
import type { JavaPreview } from "../../lib/workspace";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke, listen: async () => () => {} }));
vi.mock("../../hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = "C:\\w\\newar";
const PARENT = `${ROOT}\\aim\\src\\private\\nc\\bs\\pub\\plguin`;

/** 预览的假后端：按名字和类型给出结果，和真后端同一条规则的最小子集。 */
const fakePreview = (name: string, kind: string): JavaPreview => {
  if (name === "Exists") {
    return { package: "nc.bs.pub.plguin", fileName: "Exists.java", text: "", eol: "CRLF", error: "该目录下已有 Exists.java" };
  }
  if (!/^[A-Z]\w*$/.test(name)) {
    return { package: "nc.bs.pub.plguin", fileName: `${name}.java`, text: "", eol: "CRLF", error: "名字需以大写字母开头，只含字母、数字、下划线" };
  }
  return {
    package: "nc.bs.pub.plguin",
    fileName: `${name}.java`,
    text: `package nc.bs.pub.plguin;\r\n\r\n${kind} ${name} {\r\n\r\n}\r\n`,
    eol: "CRLF",
    error: null,
  };
};

let root: Root;
let container: HTMLDivElement;
const onClose = vi.fn();
const onCreated = vi.fn();

const flush = async () => act(async () => { await new Promise((r) => setTimeout(r, 200)); });
const typeInto = async (el: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null;
const button = (label: string) =>
  [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;
const kindBtn = (label: string) =>
  [...document.body.querySelectorAll("[role=radio]")].find((b) => b.textContent?.startsWith(label)) as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.invoke.mockImplementation(async (cmd: string, args: { name: string; kind: string }) => {
    if (cmd === "fs_java_preview") return fakePreview(args.name, args.kind);
    if (cmd === "fs_create_java") return `${PARENT}\\${args.name}.java`;
    throw new Error(`unexpected ${cmd}`);
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const mount = async () => {
  await act(async () => {
    root.render(<NewJavaTypeDialog root={ROOT} parent={PARENT} onClose={onClose} onCreated={onCreated} />);
  });
  await flush();
};

describe("guessKind", () => {
  it("I+大写开头是接口，其余是类", () => {
    expect(guessKind("IUserService")).toBe("interface");
    expect(guessKind("Item")).toBe("class");
    expect(guessKind("I")).toBe("class");
    expect(guessKind("")).toBe("class");
  });
});

describe("新建 Java 类型对话框", () => {
  it("刚打开：空名字不报红、创建禁用，并显示相对路径与包名", async () => {
    await mount();
    expect(q(".nj-err")).toBeNull();
    expect(button("创建并打开").disabled).toBe(true);
    expect(q(".nj-meta")!.textContent).toContain("aim/src/private/nc/bs/pub/plguin");
    expect(q(".nj-meta")!.textContent).toContain("nc.bs.pub.plguin");
  });

  it("输入名字后显示将写入的内容，并把 CRLF 显示成换行", async () => {
    await mount();
    await typeInto(q("#nj-name") as HTMLInputElement, "WarJob");
    await flush();
    expect(q(".nj-pv")!.textContent).toBe("package nc.bs.pub.plguin;\n\nclass WarJob {\n\n}\n");
    expect(button("创建并打开").disabled).toBe(false);
  });

  it("名字以 I+大写开头自动切到接口；手动点过类型后不再自动切", async () => {
    await mount();
    await typeInto(q("#nj-name") as HTMLInputElement, "IStock");
    expect(kindBtn("接口").getAttribute("aria-checked")).toBe("true");
    await act(async () => kindBtn("枚举").click());
    expect(kindBtn("枚举").getAttribute("aria-checked")).toBe("true");
    await typeInto(q("#nj-name") as HTMLInputElement, "IStockX");
    expect(kindBtn("枚举").getAttribute("aria-checked")).toBe("true");
    await typeInto(q("#nj-name") as HTMLInputElement, "IStockX.java");
    expect((q("#nj-name") as HTMLInputElement).value).toBe("IStockX");
  });

  it("同名文件存在：输入框标红、显示原因、创建禁用", async () => {
    await mount();
    await typeInto(q("#nj-name") as HTMLInputElement, "Exists");
    await flush();
    expect(q(".nj-err")!.textContent).toBe("该目录下已有 Exists.java");
    expect(q(".nj-field")!.hasAttribute("data-bad")).toBe(true);
    expect(button("创建并打开").disabled).toBe(true);
    expect(q(".nj-pv")).toBeNull();
  });

  it("点「创建并打开」：用所选类型创建，并把新文件路径交给调用方", async () => {
    await mount();
    await act(async () => kindBtn("后台插件").click());
    await typeInto(q("#nj-name") as HTMLInputElement, "WarJob");
    await flush();
    await act(async () => button("创建并打开").click());
    await flush();
    expect(mocks.invoke).toHaveBeenCalledWith("fs_create_java", { parent: PARENT, name: "WarJob", kind: "bgplugin" });
    expect(onCreated).toHaveBeenCalledWith(`${PARENT}\\WarJob.java`);
  });

  it("创建失败：原因显示在输入框下、对话框不关、可以改名重试", async () => {
    mocks.invoke.mockImplementation(async (cmd: string, args: { name: string; kind: string }) => {
      if (cmd === "fs_java_preview") return fakePreview(args.name, args.kind);
      throw "后端拒绝：权限不足";
    });
    await mount();
    await typeInto(q("#nj-name") as HTMLInputElement, "WarJob");
    await flush();
    await act(async () => button("创建并打开").click());
    expect(q(".nj-err")!.textContent).toContain("权限不足");
    expect(onCreated).not.toHaveBeenCalled();
    expect(button("创建并打开").disabled).toBe(false);
    await typeInto(q("#nj-name") as HTMLInputElement, "WarJob2");
    expect(q(".nj-err")).toBeNull();
  });

  it("目录不在源码根下：明确显示写入默认包", async () => {
    mocks.invoke.mockImplementation(async (_c: string, args: { name: string }) => ({
      package: null, fileName: `${args.name}.java`, text: "", eol: "CRLF", error: null,
    }));
    await mount();
    expect(q(".nj-warn")!.textContent).toContain("默认包");
  });

  it("取消：只关闭，不创建", async () => {
    await mount();
    await act(async () => button("取消").click());
    expect(onClose).toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalledWith("fs_create_java", expect.anything());
  });
});
