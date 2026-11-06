// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { metaGenerationPlan } from "../../test/metaGenerationFixture";
import { generationFixture, generationResult } from "../../test/generationWorkbenchFixture";
import { metaDetail, metaIssue } from "../../test/metaFixtures";
import type { BmfGenPlan } from "../../lib/bmf";
import { ViewActivityContext } from "../../lib/viewActivity";
import { newGenerationPreferences } from "../../lib/bmfGeneration";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));
vi.mock("./GenTextPreview", () => ({ GenTextPreview: ({ text, original, onCompared }: { text: string; original?: string; onCompared?: (ready: boolean) => void }) => { useEffect(() => onCompared?.(true), [onCompared]); return <pre className="gen-code-test">{original === undefined ? text : `${original} → ${text}`}</pre>; } }));
import { MetaGenerate } from "./MetaGenerate";
import { MetaViewPanel } from "./MetaViewPanel";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
const path = "D:/workspace/METADATA/demo.bmf";
const plan: BmfGenPlan = { ...metaGenerationPlan, warnings: ["字段长度提示"], artifacts: [{ ...metaGenerationPlan.artifacts[0], sourceRefs: ["head"] },
  { ...metaGenerationPlan.artifacts[0], id: "ddl", family: "db", kind: "ddl", name: "demo.oracle.sql", pathHint: "db/demo.oracle.sql", text: "create table demo_h (pk_demo char(20));" }] };
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label)!;
const input = (label: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const commands = (name: string) => mocks.invoke.mock.calls.filter(([cmd]) => cmd === name);
const click = async (label: string) => act(async () => button(label).click());
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { constructor(private callback: ResizeObserverCallback) {} observe(target: Element) { this.callback([{ target, contentRect: { width: 1200, height: 400 } } as ResizeObserverEntry], this as unknown as ResizeObserver); } disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation((cmd: string, args) => {
    if (cmd === "bmf_gen_preview") return Promise.resolve(generationFixture(args.root, { ...plan, profile: args.profile ?? plan.profile }, {}, args.path));
    if (cmd === "bmf_gen_check") return Promise.resolve(generationFixture(args.root, plan).check);
    if (cmd === "bmf_gen_target") return Promise.resolve("handwritten content");
    if (cmd === "bmf_gen_apply") return Promise.resolve(generationResult(args.root, { ...plan, artifacts: plan.artifacts.filter((a) => args.selected.includes(a.id)) }));
    if (cmd === "db_conn_list") return Promise.resolve([{ id: "test", name: "测试库", env: "test" }]);
    if (cmd === "db_exec") return Promise.resolve({ kind: "update", updateCount: 0, ms: 1 });
    throw new Error(`unexpected ${cmd}`);
  });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ""; vi.unstubAllGlobals(); });
const render = async (props = {}, active = true) => act(async () => root.render(<ViewActivityContext.Provider value={active}><MetaGenerate path={path} detail={metaDetail()} {...props} /></ViewActivityContext.Provider>));

it("重新生成失败清掉旧内容，主页面默认不展示性能预算或执行 SQL", async () => {
  await render(); expect(host.textContent).toContain("class DemoVO");
  expect(host.textContent).not.toContain("预算 10s"); expect(button("测试库执行…")).toBeUndefined();
  mocks.invoke.mockImplementationOnce(() => Promise.reject(new Error("bmf 文件不存在")));
  await click("更新产物");
  expect(host.textContent).toContain("bmf 文件不存在"); expect(host.textContent).not.toContain("class DemoVO");
  expect(button("检查并确认写入").disabled).toBe(true);
});
it("全不选禁用主写入操作，筛选不会改变总选择范围", async () => {
  await render(); await click("手改 / 冲突");
  expect(host.textContent).toContain("没有匹配"); expect(host.textContent).toContain("已选 2");
  await click("全不选"); expect(button("检查并确认写入").disabled).toBe(true);
  expect(commands("bmf_gen_apply")).toHaveLength(0);
});
it("规则 error 禁止写入，并提供回到校验问题入口", async () => {
  mocks.invoke.mockImplementationOnce((_cmd, args) => Promise.resolve({ ...generationFixture(args.root, plan), issues: [metaIssue({ severity: "error" })] }));
  const back = vi.fn(); await render({ onBack: back });
  expect(host.textContent).toContain("规则校验：1 错误"); expect(button("检查并确认写入").disabled).toBe(true);
  await click("修复校验问题"); expect(back).toHaveBeenCalledWith(true);
});
it("修改配置不会立即生成，输入可编辑，统一更新后才可写入", async () => {
  await render(); const packageInput = input("生成包根");
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(packageInput, "nc.vo"); packageInput.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(commands("bmf_gen_preview")).toHaveLength(1);
  expect(packageInput.disabled).toBe(false); expect(host.textContent).toContain("配置已修改");
});
it("手改文件先比较原文，覆盖决策只针对当前文件", async () => {
  mocks.invoke.mockImplementationOnce((_cmd, args) => Promise.resolve(generationFixture(args.root, plan, { vo: "modified" })));
  await render(); expect(host.textContent).toContain("默认保留原文件");
  await click("查看差异"); expect(host.textContent).toContain("handwritten content");
  const checkbox = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((n) => n.parentElement?.textContent?.includes("覆盖这个文件"))!;
  expect(checkbox.disabled).toBe(false); await act(async () => checkbox.click());
  await click("检查并确认写入"); expect(document.querySelector('[aria-label="确认写入生成产物"]')?.textContent).toContain("覆盖并备份");
  expect(commands("bmf_gen_apply")).toHaveLength(0); await click("确认写入");
  expect(commands("bmf_gen_apply")[0][1]).toMatchObject({ selected: ["vo", "ddl"], overrides: ["vo"], force: false });
  expect(document.querySelector('[aria-label="生成写入结果"]')).not.toBeNull();
});
it("写入先确认再执行，SQL 文件选择不自动加载执行控件", async () => {
  await render(); await act(async () => host.querySelector<HTMLButtonElement>('[data-file-id="ddl"]')!.click());
  expect(host.textContent).toContain("create table demo_h");
  expect(mocks.invoke.mock.calls.some(([cmd]) => cmd.startsWith("db_"))).toBe(false);
  await click("检查并确认写入"); expect(commands("bmf_gen_apply")).toHaveLength(0);
  await click("确认写入"); expect(commands("bmf_gen_apply")).toHaveLength(1);
  expect(button("测试库执行…")).toBeDefined();
});
it("SQL 执行期间阻止关闭弹窗与离开，完整执行结果留在当前会话", async () => {
  const applying = vi.fn(); let finish!: (value: unknown) => void;
  const pending = new Promise((resolve) => { finish = resolve; });
  await render({ onApplying: applying });
  await act(async () => host.querySelector<HTMLButtonElement>('[data-file-id="ddl"]')!.click());
  await click("检查并确认写入"); await click("确认写入");
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="关闭写入结果"]')!.click());
  await click("测试库执行…");
  const dialog = document.querySelector<HTMLElement>('[aria-label="生成脚本测试库执行"]')!;
  const select = dialog.querySelector<HTMLSelectElement>("select")!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "test"); select.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => { const typed = input("输入组件名确认 DDL 执行"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(typed, "demo"); typed.dispatchEvent(new Event("input", { bubbles: true })); });
  mocks.invoke.mockImplementationOnce(() => pending);
  await click("执行 DDL");
  const close = dialog.querySelector<HTMLButtonElement>('[aria-label="关闭脚本执行"]')!;
  expect(close.disabled).toBe(true); expect(button("返回元数据").disabled).toBe(true);
  expect(applying).toHaveBeenLastCalledWith(true);
  await act(async () => { close.click(); dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); const overlay = dialog.parentElement!; overlay.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); overlay.click(); });
  expect(dialog.dataset.exiting).toBeUndefined(); expect(commands("db_exec")).toHaveLength(1);
  mocks.invoke.mockImplementationOnce(() => Promise.reject(new Error("源文件暂不可读")));
  await render({ detail: { ...metaDetail(), sha256: "external-refresh" }, onApplying: applying });
  expect(dialog.dataset.exiting).toBeUndefined(); expect(dialog.textContent).toContain("执行中…");
  await render({ detail: { ...metaDetail(), sha256: "external-refresh" }, onApplying: applying }, false);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 250)));
  expect(document.body.contains(dialog)).toBe(true); expect(dialog.parentElement!.style.display).toBe("none");
  await act(async () => finish({ kind: "update", updateCount: 0, ms: 1 }));
  await render({ detail: { ...metaDetail(), sha256: "external-refresh" }, onApplying: applying });
  expect(dialog.textContent).toContain("全部语句执行成功"); expect(close.disabled).toBe(false);
  expect(commands("db_conn_list")).toHaveLength(1); expect(commands("db_exec")).toHaveLength(1);
  expect(applying).toHaveBeenLastCalledWith(false);
});
it("来源按钮联动定位元数据实体", async () => {
  const locate = vi.fn(); await render({ onLocate: locate });
  await click("来源与依赖"); await click("head实体");
  expect(locate).toHaveBeenCalledWith({ kind: "entity", entityId: "head" });
});
it("切换两份已打开的 BMF 生成页时，各自恢复配置和选择而不串用输出目录", async () => {
  const first = metaDetail("first"), second = metaDetail("second");
  const prefsA = { ...newGenerationPreferences(first.path), root: "D:/workspace/projectA", profile: { ...plan.profile, basePackage: "nc.vo.first" }, selected: ["vo"] };
  const prefsB = { ...newGenerationPreferences(second.path), root: "D:/workspace/projectB", profile: { ...plan.profile, basePackage: "nc.vo.second" }, selected: [] };
  const show = async (detail: typeof first, generationPreferences: typeof prefsA) => act(async () => root.render(
    <MetaViewPanel view="generate" detail={detail} error={null} busy={false} entries={[]} editor={null} onEdited={() => {}} generationPreferences={generationPreferences} />,
  ));
  await show(first, prefsA);
  expect(input("生成包根").value).toBe("nc.vo.first");
  await show(second, prefsB);
  expect(input("生成包根").value).toBe("nc.vo.second");
  expect(input("输出目录")?.value ?? document.querySelector<HTMLInputElement>("#gen-output-root")!.value).toBe("D:/workspace/projectB");
  expect(button("检查并确认写入").disabled).toBe(true);
  await show(first, prefsA);
  expect(input("生成包根").value).toBe("nc.vo.first");
  expect(document.querySelector<HTMLInputElement>("#gen-output-root")!.value).toBe("D:/workspace/projectA");
});
it("键盘在文件清单中移动并用空格勾选", async () => {
  await render(); const first = host.querySelector<HTMLButtonElement>('[data-file-id="vo"]')!;
  await act(async () => first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  const next = host.querySelector<HTMLButtonElement>('[data-file-id="ddl"]')!;
  expect(next.getAttribute("aria-pressed")).toBe("true");
  await act(async () => next.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })));
  expect(input("选择 demo.oracle.sql").checked).toBe(false);
});
