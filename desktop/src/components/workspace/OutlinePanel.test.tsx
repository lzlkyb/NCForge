// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OutlinePanel } from "./OutlinePanel";

const PATH = "C:\\w\\newar\\modules\\ic\\A.java";
const SYMS = [
  { name: "A", kind: 5, container: "", line: 3 },
  { name: "foo", kind: 6, container: "A", line: 10 },
];

const mocks = vi.hoisted(() => ({ symbolsFor: vi.fn() }));
vi.mock("../../lib/lang", () => ({
  useLangView: () => ({ state: "ready" }),
  inLangModule: () => true,
}));
vi.mock("../../lib/symbols", () => ({
  symbolsFor: (...a: unknown[]) => mocks.symbolsFor(...a),
  kindLetter: (k: number) => `K${k}`,
}));

let root: Root;
let container: HTMLDivElement;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 触发按钮放在面板外面（真实结构里在 EditorNavRow 行内），验证排除逻辑 */
function Harness({ onClose = () => {} }: { onClose?: () => void }) {
  return (
    <>
      <button type="button" data-popover="outline">
        结构
      </button>
      <OutlinePanel open={true} onClose={onClose} path={PATH} mtimeMs={1} onJump={() => {}} />
    </>
  );
}

/** 原生派发：外点/Esc 监听都挂在 document 上，不走 React 合成事件 */
const fire = (target: EventTarget, type: string, init: MouseEventInit = {}) => {
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, ...init }));
  });
};

const render = async (ui: React.ReactElement) => {
  await act(async () => root.render(ui));
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.symbolsFor.mockResolvedValue(SYMS);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("OutlinePanel", () => {
  it("就绪时拉符号并摊成行", async () => {
    await render(<Harness />);
    expect(mocks.symbolsFor).toHaveBeenCalledWith(PATH, 1);
    expect(container.querySelectorAll(".wb-outline-row").length).toBe(2);
  });

  it("点面板外面关闭（监听在 document 上，不再有全屏遮罩）", async () => {
    const onClose = vi.fn();
    await render(<Harness onClose={onClose} />);
    fire(document.body, "pointerdown");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("点面板内部不关", async () => {
    const onClose = vi.fn();
    await render(<Harness onClose={onClose} />);
    fire(container.querySelector(".wb-outline-q")!, "pointerdown");
    fire(container.querySelectorAll(".wb-outline-row")[0], "pointerdown");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("点触发按钮不关：那是开关，交给外层 toggle，否则会变成先关再开", async () => {
    const onClose = vi.fn();
    await render(<Harness onClose={onClose} />);
    fire(container.querySelector('[data-popover="outline"]')!, "pointerdown");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Esc 在文档级生效：焦点在列表行按钮上时也能关（原来只有过滤框能关）", async () => {
    const onClose = vi.fn();
    await render(<Harness onClose={onClose} />);
    const row = container.querySelectorAll<HTMLButtonElement>(".wb-outline-row")[0];
    row.focus();
    act(() => {
      row.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("点一行跳到对应行并关闭", async () => {
    const onClose = vi.fn();
    const onJump = vi.fn();
    await act(async () =>
      root.render(
        <OutlinePanel open={true} onClose={onClose} path={PATH} mtimeMs={1} onJump={onJump} />,
      ),
    );
    await act(async () => {
      container.querySelectorAll<HTMLButtonElement>(".wb-outline-row")[1].click();
    });
    expect(onJump).toHaveBeenCalledWith(10);
    expect(onClose).toHaveBeenCalled();
  });
});

describe("结构加载与失败",()=>{
  it("等待时显示加载，失败保留错误，重试后才显示空结果",async()=>{
    let reject!:(e:unknown)=>void;mocks.symbolsFor.mockReturnValue(new Promise((_,no)=>{reject=no;}));
    await render(<Harness/>);expect(container.textContent).toContain("正在读取文件结构");expect(container.textContent).not.toContain("没有可显示");
    await act(async()=>{reject("代码智能超时");});expect(container.textContent).toContain("代码智能超时");expect(container.textContent).not.toContain("没有可显示");
    mocks.symbolsFor.mockResolvedValue([]);await act(async()=>{container.querySelector<HTMLButtonElement>(".wb-outline-note button")!.click();});
    expect(container.textContent).toContain("没有可显示的符号");expect(mocks.symbolsFor).toHaveBeenCalledTimes(2);
  });
  it("旧路径请求返回不会替换新文件结构",async()=>{
    let resolve!:(x:typeof SYMS)=>void;mocks.symbolsFor.mockReturnValueOnce(new Promise(yes=>{resolve=yes;})).mockResolvedValueOnce([]);
    await render(<OutlinePanel open onClose={()=>{}} path={PATH} onJump={()=>{}}/>);
    await render(<OutlinePanel open onClose={()=>{}} path="C:\\w\\B.java" onJump={()=>{}}/>);
    await act(async()=>{resolve(SYMS);});expect(container.querySelectorAll(".wb-outline-row")).toHaveLength(0);expect(container.textContent).toContain("没有可显示");
  });
});
