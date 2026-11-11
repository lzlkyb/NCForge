// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  delete (document as unknown as { fonts?: FontFaceSet }).fonts;
});

it("无 FontFaceSet 的测试宿主不阻塞；后续可初始化并只订阅一次", async () => {
  vi.resetModules();
  const fonts = await import("./fonts");
  const target = new EventTarget(), add = vi.spyOn(target, "addEventListener");
  let available = false;
  Object.defineProperty(document, "fonts", { configurable: true, get: () => available ? target : undefined });
  fonts.initializeFonts();
  available = true;
  const notify = vi.fn(), off = fonts.subscribeFonts(notify);
  fonts.initializeFonts();
  expect(add).toHaveBeenCalledOnce();
  expect(fonts.getFontRevision()).toBe(0);
  target.dispatchEvent(new Event("loadingdone"));
  expect(fonts.getFontRevision()).toBe(1);
  expect(notify).toHaveBeenCalledOnce();
  off();
  target.dispatchEvent(new Event("loadingdone"));
  expect(notify).toHaveBeenCalledOnce();
});

it("字体交换后文本与结果集测宽缓存一起失效，使用与表格相同的字体栈", async () => {
  vi.resetModules();
  const target = new EventTarget();
  Object.defineProperty(document, "fonts", { configurable: true, value: target });
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Chrome");
  let perChar = 6;
  const ctx = { font: "", measureText: vi.fn((text: string) => ({ width: text.length * perChar })) };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  const fonts = await import("./fonts"), metrics = await import("./resultView");
  const { wrapLineCount } = await import("./gridRowMetrics");
  fonts.initializeFonts();
  const columns = [{ name: "CODE", type: "VARCHAR2", precision: 20, scale: 0 }], rows = [["中文O0I1l123456789"]];
  const initial = metrics.initialWidths(columns, rows);
  expect(metrics.initialWidths(columns, rows)).toBe(initial);
  expect(ctx.font).toContain(fonts.UI_FONT_FAMILY);
  expect(metrics.textWidth("O0I1l")).toBe(30);
  expect(wrapLineCount("123456789012345", 100)).toBe(1);
  perChar = 10;
  target.dispatchEvent(new Event("loadingdone"));
  expect(metrics.textWidth("O0I1l")).toBe(50);
  expect(wrapLineCount("123456789012345", 100)).toBe(2);
  expect(metrics.initialWidths(columns, rows)[0]).toBeGreaterThan(initial[0]);
  expect(metrics.initialWidths(columns, rows)).not.toBe(initial);
  delete (document as unknown as { fonts?: FontFaceSet }).fonts;
});
