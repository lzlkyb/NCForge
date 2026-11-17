import { test } from "node:test";
import assert from "node:assert/strict";
import { ALLOW, audit, formatReport } from "./three-states.mjs";

test("三态齐全的文件不进清单", () => {
  const rows = audit([
    {
      path: "src/a/A.tsx",
      text: 'const q = useQuery(...); return <EmptyState/> && <LoadingState/>; try {} catch (e) {}',
    },
  ]);
  assert.deepEqual(rows, []);
});

test("有载态却没有任何失败出口 → 记缺陷（载态掩盖失败）", () => {
  const rows = audit([{ path: "src/a/A.tsx", text: "useQuery({}); 正在读取…" }]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].missing, ["空", "错"]);
});

test("有错态没有载态是合理取舍，不报", () => {
  // 错误信息本身就是终态，不需要额外转圈；判据只禁「永远停在载态」。
  const rows = audit([{ path: "src/a/A.tsx", text: "invoke('x'); try {} catch (e) {}" }]);
  assert.deepEqual(rows, []);
});

test("内联语义写法（role=status / role=alert）算三态齐全", () => {
  // 代码库里有 20 个组件用内联写法而非具名组件，按组件名匹配会 100% 误报。
  const rows = audit([
    {
      path: "src/a/A.tsx",
      text: 'useQuery({}); <div role="status">正在读取</div>; <div role="alert">{String(err)}</div>',
    },
  ]);
  assert.deepEqual(rows, []);
});

test("状态胶囊用 data-tone 编码三态，不要求具名组件", () => {
  const rows = audit([
    {
      path: "src/a/A.tsx",
      text: 'useQuery({}); <span data-tone="busy">扫描中</span>; <span data-tone="bad">{String(err)}</span>',
    },
  ]);
  assert.deepEqual(rows, []);
});

test("没有数据请求的组件不审计，hooks 目录跳过", () => {
  const rows = audit([
    { path: "src/a/A.tsx", text: "export const A = () => <div/>;" },
    { path: "src/hooks/useThing.tsx", text: "const q = useQuery({});" },
  ]);
  assert.deepEqual(rows, []);
});

test("ALLOW 登记过的文件不出现，报告文案随清单变化", () => {
  const known = Object.keys(ALLOW)[0];
  const rows = audit([{ path: known, text: "invoke('x'); 正在读取…" }]);
  assert.equal(rows.length, 0);
  assert.match(formatReport([]), /都具备空\/载\/错三态/);
});
