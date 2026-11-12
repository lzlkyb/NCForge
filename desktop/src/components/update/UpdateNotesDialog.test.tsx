// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateNotesDialog } from "./UpdateNotesDialog";
import type { UpdateNotesInfo } from "../../lib/updateNotes";
import { AVAILABLE_PROCESS, type UpdateDialogProcess } from "./UpdateProcess";

vi.mock("../../hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
const close = vi.fn(), download = vi.fn(), dismiss = vi.fn(), restart = vi.fn(), retry = vi.fn();
const props = { open: true, update: { version: "99.0.0", currentVersion: "2.9.1", body: "### 亮点\n- **更稳定**：可靠复制\n### 修复\n- <img src=x onerror=alert(1)>" }, onClose: close, onDownload: download, onDismiss: dismiss, onRestart: restart, onRetry: retry };
const button = (text: string) => [...document.querySelectorAll("button")].find(node => node.textContent?.includes(text))!;

beforeEach(() => { vi.clearAllMocks(); root = createRoot(document.createElement("div")); });
afterEach(async () => { await act(async () => root.unmount()); });
async function mount(update: UpdateNotesInfo | null = props.update, process?: UpdateDialogProcess) { await act(async () => root.render(<UpdateNotesDialog {...props} update={update} process={process} />)); }

describe("update dialog behavior", () => {
  it("关闭不抑制当前版本，也不会触发下载", async () => {
    await mount();
    await act(async () => (document.querySelector('[aria-label="关闭更新弹窗"]') as HTMLButtonElement).click());
    expect(close).toHaveBeenCalledOnce();
    expect(dismiss).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });
  it("稍后提醒只关闭，不写忽略记忆", async () => {
    await mount(); await act(async () => button("稍后提醒").click());
    expect(dismiss).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
    expect(download).not.toHaveBeenCalled();
  });
  it("只有明确忽略此版本才抑制并关闭", async () => {
    await mount(); await act(async () => button("忽略此版本").click());
    expect(dismiss).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
    expect(dismiss.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]);
    expect(download).not.toHaveBeenCalled();
  });
  it("下载发起后保持弹框显示进度，不写忽略记忆", async () => {
    await mount(); await act(async () => button("下载更新").click());
    expect(download).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
  });
  it("记录按需挂载，远端内容以安全文本呈现，切换版本重置折叠", async () => {
    await mount();
    expect(document.querySelector('.update-release-notes')).toBeNull();
    await act(async () => button("完整记录").click());
    expect(document.querySelector('.update-release-notes')?.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(document.querySelectorAll('img')).toHaveLength(1);
    await mount({ ...props.update, version: "100.0.0" });
    expect(button("更新亮点").getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector('.update-release-notes')).toBeNull();
  });
  it("纯文字说明原样保留，无从汇总时不伪造统计与亮点", async () => {
    await mount({ ...props.update, body: "plain note" });
    await act(async () => button("完整记录").click());
    expect(document.querySelector('.update-release-notes')?.textContent).toContain('plain note');
    // 🔴 必须显式去掉 currentVersion：只要给了它，模型就会按 2.9.1 → 99.0.0 汇总**随包的** CHANGELOG，
    // 记录数与亮点条目随每次发版变化 —— 原断言（指望 .update-stats 为空）因此成了时间炸弹，
    // 2026-10-20 发版后实际渲染出「55 条更新记录 / 28 改进」而变红。
    // 拿不到当前版本 = 无从判断升级范围 ⇒ 不做跨版本汇总，这才是「没有说明就没有统计」的真实前提。
    await mount({ ...props.update, body: "", currentVersion: undefined });
    await act(async () => button("完整记录").click());
    expect(document.body.textContent).toContain("此版本未提供详细说明");
    expect(document.querySelector('.update-stats')).toBeNull();
    expect(document.querySelector('.update-benefits')).toBeNull();
  });

  it("有当前版本时按区间汇总随包记录（stats 与亮点反映累计，不是本次发布的伪统计）", async () => {
    // 与上一条互补：证明 stats 的出现条件是「存在可汇总的区间」，而不是 body 里有没有字。
    // currentVersion 取壳子随包 CHANGELOG（0.0.9 / 0.1.0）之下的 0.0.8：区间 (0.0.8, 99.0.0)
    // 内有两版记录 ⇒ cross 汇总成立。cc-bridge 原版用 2.9.1 是因为它的 CHANGELOG 有 2.9.x 史。
    await mount({ ...props.update, body: "", currentVersion: "0.0.8" });
    expect(document.body.textContent).toContain("汇总已收录的");
    expect(document.querySelector('.update-stats')).not.toBeNull();
    // 本次发布没有说明 ⇒ 详情区仍要诚实地说没有，不能用汇总内容冒充。
    expect(document.querySelector(".update-content-nav")?.textContent).toContain("完整记录");
  });
  it("进度变化保持收起按钮焦点，未知大小不伪造百分比", async () => {
    const downloading = { ...AVAILABLE_PROCESS, status: "downloading" as const, progress: 42, downloadedBytes: 42, totalBytes: 100 };
    await mount(props.update, downloading);
    const background = button("收起到后台"); background.focus();
    await mount(props.update, { ...downloading, progress: 49, downloadedBytes: 49 });
    expect(button("收起到后台")).toBe(background);
    expect(document.activeElement).toBe(background);
    expect(document.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("49");
    await mount(props.update, { ...downloading, totalBytes: null, progressIndeterminate: true });
    expect(document.querySelector('[role="progressbar"]')?.hasAttribute("aria-valuenow")).toBe(false);
    expect(document.querySelector('[role="progressbar"]')?.getAttribute("aria-valuetext")).toBe("总大小未知");
    await act(async () => background.click()); expect(close).toHaveBeenCalledOnce();
  });
  it("就绪态先显示确认，点击后才安装并重启", async () => {
    await mount(props.update, { ...AVAILABLE_PROCESS, status: "ready", progress: 100 });
    expect(document.body.textContent).toContain("更新包已下载并验证");
    expect(restart).not.toHaveBeenCalled(); expect(download).not.toHaveBeenCalled();
    await act(async () => button("安装并重启").click());
    expect(restart).toHaveBeenCalledOnce(); expect(download).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
  it("没有版本信息的检查失败也能打开详情并重试", async () => {
    await mount(null, { ...AVAILABLE_PROCESS, status: "error", errorCode: "network", error: "failed to fetch <img src=x>" });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain("无法连接更新服务器");
    await act(async () => button("重新检查").click()); expect(retry).toHaveBeenCalledOnce();
    expect(download).not.toHaveBeenCalled();
    expect(document.querySelectorAll("img")).toHaveLength(1);
  });
  it("安装期间不会由关闭按钮或Esc中断", async () => {
    await mount(props.update, { ...AVAILABLE_PROCESS, status: "installing" });
    const closeButton = document.querySelector('[aria-label="关闭更新弹窗"]') as HTMLButtonElement;
    expect(closeButton.disabled).toBe(true);
    await act(async () => closeButton.click());
    await act(async () => document.querySelector('[role="dialog"]')?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(close).not.toHaveBeenCalled();
  });
  it("亮点不再截成三项，完整记录按需挂载", async () => {
    await mount({ version: "99.0.0", body: "### 亮点\n- 第一项\n- 第二项\n- 第三项\n- 第四项\n- 第五项" });
    expect(document.querySelectorAll('.update-benefits>li')).toHaveLength(5);
    expect(document.querySelector('.update-release-notes')).toBeNull();
    await act(async () => button("完整记录").click());
    expect(document.querySelector('.update-release-notes')?.textContent).toContain("第五项");
  });
  it("没有「亮点」小节时用更新摘要撑起顶部卡片，不留空白", async () => {
    await mount({ version: "99.0.0", body: "### 更新摘要\n标签栏各归其页，关于页一并改进\n\n### 修复\n- 修好了" });
    const cards = document.querySelectorAll('.update-benefits>li');
    expect(cards).toHaveLength(1);
    expect(cards[0].textContent).toContain("标签栏各归其页，关于页一并改进");
  });
});

it("0.2.0 升到 0.3.0 展示八个亮点，完整记录可搜索，进度不重置视图", async () => {
  const info = {version:"0.3.0",currentVersion:"0.2.0",body:""};
  await mount(info, {...AVAILABLE_PROCESS,status:"ready"});
  expect(document.querySelectorAll(".update-benefits>li")).toHaveLength(8);
  expect(document.body.textContent).toContain("NC 热替换免重启");
  const content = document.querySelector<HTMLDivElement>(".update-dialog-scroll")!;
  content.scrollTop = 200;
  await act(async () => button("完整记录").click());
  expect(content.scrollTop).toBe(0);
  const input = document.querySelector<HTMLInputElement>('[aria-label="搜索更新记录"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"unknown TTC");
    input.dispatchEvent(new Event("input",{bubbles:true}));
  });
  expect(document.querySelector(".update-release-notes")?.textContent).toContain("unknown TTC");
  await mount(info, {...AVAILABLE_PROCESS,status:"ready",progress:100});
  expect(document.querySelector<HTMLInputElement>('[aria-label="搜索更新记录"]')?.value).toBe("unknown TTC");
  expect(restart).not.toHaveBeenCalled();
});
