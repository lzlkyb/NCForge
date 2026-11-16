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

test("缺哪一态就记哪一态，缺得多的排前面", () => {
  const rows = audit([
    { path: "src/a/A.tsx", text: "const q = useQuery({}); return <EmptyState/>;" },
    { path: "src/b/B.tsx", text: "invoke('x');" },
  ]);
  assert.equal(rows[0].path, "src/b/B.tsx");
  assert.deepEqual(rows[0].missing, ["空", "载", "错"]);
  const a = rows.find((r) => r.path === "src/a/A.tsx");
  assert.ok(a.missing.includes("载"));
  assert.ok(!a.missing.includes("空"));
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
  const rows = audit([{ path: known, text: "invoke('x');" }]);
  assert.equal(rows.length, 0);
  assert.match(formatReport([]), /都具备空\/载\/错三态/);
});
