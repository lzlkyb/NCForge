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

test("超过基线报违规，低于基线提示可下调", () => {
  const files = [
    { path: "src/a.tsx", text: `import { Modal } from "../ui/Modal";` },
    { path: "src/b.tsx", text: `import { Modal } from "../ui/Modal";` },
  ];
  const over = checkDeprecated(files, { "components/ui/Modal": 1 });
  assert.equal(over.violations.length, 1);
  assert.equal(over.violations[0].actual, 2);
  assert.equal(over.violations[0].replacement, "components/ui/dialog");

  const under = checkDeprecated(files, { "components/ui/Modal": 5 });
  assert.equal(under.violations.length, 0);
  assert.match(under.stale[0], /基线 5 → 实际 2/);
});

test("没有替代品的组件不设棘轮（Menu 不出现在违规里）", () => {
  const files = [{ path: "src/a.tsx", text: `import { Menu } from "../ui/Menu";` }];
  const { violations } = checkDeprecated(files, {});
  assert.deepEqual(violations, []);
});
