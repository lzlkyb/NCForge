import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCommands, formatReport, summarize } from "./palette-inventory.mjs";

test("只有带 run 的对象才算命令，静态快捷键表被排除", () => {
  const text = [
    "const SHORTCUTS = [",
    '  { id: "fixed.save", label: "保存" },',
    '  { id: "fixed.find", label: "查找" },',
    "];",
    "registerCommands([",
    '  { id: "build.rebuild", title: "重编当前模块", hint: "Ctrl+F9", run: () => rebuild() },',
    "]);",
  ].join("\n");
  const cmds = extractCommands(text);
  assert.deepEqual(cmds.map((c) => c.id), ["build.rebuild"]);
  assert.equal(cmds[0].hint, "Ctrl+F9");
});

test("命令数组定义在 registerCommands 之前也能识别", () => {
  const text = [
    "const NAV = [",
    '  { id: "nav.back", title: "后退", run: () => back() },',
    '  { id: "nav.forward", title: "前进", run: () => forward() },',
    "];",
    "export function useNav() { return registerCommands(NAV); }",
  ].join("\n");
  assert.equal(extractCommands(text).length, 2);
});

test("hint 为表达式时保留原文，title 用模板字符串也能取到", () => {
  const text = [
    "registerCommands([",
    "  {",
    '    id: "go.patch",',
    "    title: `转到：补丁打包`,",
    "    hint: WORKSPACE_SEARCH_KEY,",
    "    run: openPatch,",
    "  },",
    "]);",
  ].join("\n");
  const [cmd] = extractCommands(text);
  assert.equal(cmd.title, "转到：补丁打包");
  assert.equal(cmd.hint, "WORKSPACE_SEARCH_KEY");
});

test("summarize 汇总注册点与缺失提示，formatReport 列出无提示命令", () => {
  const files = [
    { path: "src/a.tsx", text: 'registerCommands([\n{ id: "x.one", title: "一", run: f },\n]);' },
    { path: "src/b.tsx", text: 'registerCommands([\n{ id: "x.two", title: "二", hint: "Ctrl+2", run: g },\n]);' },
    { path: "src/c.tsx", text: "export const nothing = 1;" },
  ];
  const s = summarize(files);
  assert.equal(s.total, 2);
  assert.equal(s.withHint, 1);
  assert.equal(s.missingHint.length, 1);
  assert.equal(s.missingHint[0].id, "x.one");
  assert.equal(s.byFile.length, 2);
  assert.match(formatReport(s), /没有快捷键提示的命令（1 条/);
});
