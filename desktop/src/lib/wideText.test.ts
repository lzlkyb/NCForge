import { expect, it } from "vitest";
import { CELL_TEXT_MAX, isWideText } from "./wideText";

/** 截图里那格：VARCHAR2(2000) 的报错文本，2000 字符以内，曾经三个判据全漏。 */
const ERR_MESSAGE = `反馈传输数据失败！【出库回传失败】{"code":"0","success":true,"message":"ok"}`.padEnd(1200, "回");

it("VARCHAR2(2000) 的报错堆栈算「显示不全」——它不是 CLOB 预览，但网格只露 300 字", () => {
  expect(ERR_MESSAGE.length).toBeLessThan(2000);
  expect(isWideText(ERR_MESSAGE)).toBe(true);
});

it("长度边界按网格上限算：正好 300 不算，301 才算", () => {
  expect(CELL_TEXT_MAX).toBe(300);
  expect(isWideText("x".repeat(CELL_TEXT_MAX))).toBe(false);
  expect(isWideText("x".repeat(CELL_TEXT_MAX + 1))).toBe(true);
});

it("含换行的值即使很短也算：单行网格读不出结构", () => {
  expect(isWideText("a\nb")).toBe(true);
  expect(isWideText("a\rb")).toBe(true);
});

it("开了自动换行后，多行短值不再算显示不全（否则每格都多一个「…」按钮）", () => {
  expect(isWideText("a\nb", true)).toBe(false);
  // 被 300 字上限截断、或后端只带预览的，换行也看不全，仍要给入口。
  expect(isWideText("x".repeat(CELL_TEXT_MAX + 1), true)).toBe(true);
});

it("后端 8K 预览认尾巴标记（与 db.ts 同一份文案）", () => {
  expect(isWideText(`${"x".repeat(20)} …（共 9,999 个字符，只显示前 8192，点「加载完整值」查看）`)).toBe(true);
});

it("NULL、空串、数字、短文本都不算", () => {
  expect(isWideText(null)).toBe(false);
  expect(isWideText("")).toBe(false);
  expect(isWideText(120)).toBe(false);
  expect(isWideText("出库回传失败")).toBe(false);
});
