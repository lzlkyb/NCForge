import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCssModalWidth, checkJsxModalWidth, isModalShell } from "./modal-width.mjs";

test("弹层外壳识别：类名最后一段含 dialog/modal 才算", () => {
  assert.equal(isModalShell(".vc-dialog"), true);
  assert.equal(isModalShell(".dbx-dlg"), false); // 老缩写不含关键词，靠 var() 约束而非本规则
  assert.equal(isModalShell(".vc-dialog-hk"), true);
  assert.equal(isModalShell(".dbx-object-dialog,.dbx-column-dialog"), true);
});

test("弹层内部元素不算外壳", () => {
  // 滚动条、按钮、列表项都是弹层里的东西，各自的小尺寸不该被档位管
  assert.equal(isModalShell(".update-dialog-scroll::-webkit-scrollbar"), false);
  assert.equal(isModalShell(".update-dialog-actions .ui-button:last-child"), false);
  assert.equal(isModalShell(".restart-overlay .ro-bar"), false);
});

test("抽屉不纳入：宽度相对容器而非视口", () => {
  assert.equal(isModalShell(".dbx-drawer"), false);
  assert.equal(isModalShell(".vc-commit-drawer"), false);
  assert.equal(isModalShell(".sc-drawer"), false);
});

test(":is(...) 里的弹层选择器能识别", () => {
  assert.equal(isModalShell('html[data-ui-style="glass"] :is(.dbx-dlg,.dbx-object-dialog)'), true);
});

test("CSS 里写死 px 宽度 → 违规", () => {
  const rows = checkCssModalWidth([
    { path: "src/a.css", text: ".vc-dialog {\n  width: 520px;\n}" },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, "520px");
  assert.equal(rows[0].selector, ".vc-dialog");
});

test("single-line 规则也能抓到", () => {
  const rows = checkCssModalWidth([
    { path: "src/a.css", text: ".gen-modal { display:flex; width: min(760px, calc(100vw - 32px)); }" },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, "760px");
});

test("用档位令牌 → 通过", () => {
  const rows = checkCssModalWidth([
    { path: "src/a.css", text: ".vc-dialog {\n  width: var(--w-modal-md);\n}" },
  ]);
  assert.deepEqual(rows, []);
});

test("max-width / @container 条件不算 width 声明", () => {
  const rows = checkCssModalWidth([
    {
      path: "src/a.css",
      text: '@container dialog (max-width: 760px) {\n  .vc-dialog { width: var(--w-modal-sm); }\n}\n.vc-dialog {\n  max-width: 620px;\n}',
    },
  ]);
  assert.deepEqual(rows, []);
});

test("design-preview 独立入口豁免", () => {
  const rows = checkCssModalWidth([
    { path: "src/design-preview/x.css", text: ".wd-modal {\n  width: 560px;\n}" },
  ]);
  assert.deepEqual(rows, []);
});

test("tsx 里 Modal 的内联宽度 → 违规", () => {
  const rows = checkJsxModalWidth([
    { path: "src/a.tsx", text: '<Modal open className="modal-surface w-[620px] p-5">' },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, "620px");
});

test("tsx 里普通元素的内联宽度不管", () => {
  const rows = checkJsxModalWidth([{ path: "src/a.tsx", text: '<div className="w-[620px]">' }]);
  assert.deepEqual(rows, []);
});

test("tsx 里用令牌 → 通过", () => {
  const rows = checkJsxModalWidth([
    { path: "src/a.tsx", text: '<Modal open className="modal-surface w-[var(--w-modal-md)] p-5">' },
  ]);
  assert.deepEqual(rows, []);
});

// 2026-11-17 实测漏网：ShortcutSheet 用 `w-[min(720px,92vw)]`，旧正则只认纯 `w-[NNNpx]`，
// 720 这个宽度既不在档位里、也没被任何检查拦住——真实弹窗在 dev server 里量出 722px 才暴露。
test("tsx 里自写视口兜底 w-[min(Npx,NNvw)] → 违规（无需 Modal 上下文）", () => {
  const rows = checkJsxModalWidth([
    { path: "src/a.tsx", text: '<div className="flex w-[min(720px,92vw)] flex-col p-5">' },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, "w-[min(720px, …vw)]");
});

test("令牌自带兜底，所以配 min() 再套一层也算违规", () => {
  const rows = checkJsxModalWidth([
    { path: "src/a.tsx", text: '<div className="w-[min(460px,92vw)]">' },
  ]);
  assert.equal(rows.length, 1);
});

test("max-w-[calc(100vw-8px)] 不是弹层宽度，不误报", () => {
  const rows = checkJsxModalWidth([
    { path: "src/a.tsx", text: '<div className="max-w-[calc(100vw-8px)] overflow-auto">' },
  ]);
  assert.deepEqual(rows, []);
});

test("弹层内部的定宽字段（w-[260px]）不误报", () => {
  const rows = checkJsxModalWidth([
    {
      path: "src/a.tsx",
      text: [
        "<Modal open>",
        "  <div>",
        '    <input className="w-[260px]" />',
        "  </div>",
        "</Modal>",
      ].join("\n"),
    },
  ]);
  assert.deepEqual(rows, []);
});
