import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDeprecated, collectImports, normalizeImportPath } from "./deprecated-ui.mjs";

test("导入路径归一化：相对层级与同目录写法指向同一模块", () => {
  assert.equal(normalizeImportPath("../ui/Modal"), "components/ui/Modal");
  assert.equal(normalizeImportPath("../../ui/Modal"), "components/ui/Modal");
  assert.equal(normalizeImportPath("./Modal"), "components/ui/Modal");
  assert.equal(normalizeImportPath("../ui/ConfirmDialog"), "components/ui/ConfirmDialog");
  assert.equal(normalizeImportPath("../lib/utils"), null);
});

test("统计导入文件，跳过组件自身，同文件重复导入只算一次", () => {
  const files = [
    { path: "src/components/ui/Modal.tsx", text: `import { Modal } from "./Modal";` },
    { path: "src/components/ui/ConfirmDialog.tsx", text: `import { Modal } from "./Modal";\nimport { Modal } from "./Modal";` },
    { path: "src/components/a/A.tsx", text: `import { Modal } from "../ui/Modal";` },
    { path: "src/components/b/B.tsx", text: `import { Menu } from "../ui/Menu";` },
  ];
  const imports = collectImports(files);
  assert.deepEqual(imports["components/ui/Modal"], ["src/components/a/A.tsx", "src/components/ui/ConfirmDialog.tsx"]);
  assert.equal(imports["components/ui/Menu"].length, 1);
});

test("基线为空时什么都不报（当前真实状态：Modal 不设棘轮）", () => {
  const files = [
    { path: "src/a.tsx", text: `import { Modal } from "../ui/Modal";` },
    { path: "src/b.tsx", text: `import { Modal } from "../ui/Modal";` },
  ];
  const { violations, stale } = checkDeprecated(files, { "components/ui/Modal": 54 });
  assert.deepEqual(violations, []);
  assert.deepEqual(stale, []);
});

test("机制仍可用：登记后超基线报违规、低于基线提示下调", () => {
  // 用注入的模块表验证机制，不依赖真实 DEPRECATED_MODULES（当前为空）。
  const modules = { "components/ui/LegacyThing": { replacement: "components/ui/NewThing" } };
  const files = [
    { path: "src/a.tsx", text: `import { LegacyThing } from "../ui/LegacyThing";` },
    { path: "src/b.tsx", text: `import { LegacyThing } from "../ui/LegacyThing";` },
  ];
  const over = checkDeprecated(files, { "components/ui/LegacyThing": 1 }, modules);
  assert.equal(over.violations.length, 1);
  assert.equal(over.violations[0].actual, 2);
  assert.equal(over.violations[0].replacement, "components/ui/NewThing");

  const under = checkDeprecated(files, { "components/ui/LegacyThing": 5 }, modules);
  assert.equal(under.violations.length, 0);
  assert.match(under.stale[0], /基线 5 → 实际 2/);
});

test("没有替代品的组件不设棘轮（Menu 不出现在违规里）", () => {
  const files = [{ path: "src/a.tsx", text: `import { Menu } from "../ui/Menu";` }];
  const { violations } = checkDeprecated(files, {});
  assert.deepEqual(violations, []);
});
