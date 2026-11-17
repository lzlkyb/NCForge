import assert from "node:assert/strict";
import test from "node:test";
import {
  diffAgainstBaseline,
  isStringResult,
  normalizeBaseline,
  scanCommands,
  splitTopLevel,
  stringResultCommands,
} from "./error-contract.mjs";

test("识别 Result<_, String> 的各种写法", () => {
  assert.equal(isStringResult("Result<(), String>"), true);
  assert.equal(isStringResult("Result<Vec<PlanItem>, String>"), true);
  assert.equal(isStringResult("Result<String, String>"), true);
  // 返回类型自己带逗号：不能用「第一个逗号」切
  assert.equal(isStringResult("Result<HashMap<String, u32>, String>"), true);
  // 带路径 / 多余空白
  assert.equal(isStringResult("Result<(), std::string::String>"), true);
  assert.equal(isStringResult("std::result::Result<X, String>"), true);
  assert.equal(isStringResult("Result<X , String >"), true);
});

test("非 String 错误不当违规", () => {
  assert.equal(isStringResult("Result<(), AppError>"), false);
  assert.equal(isStringResult("Option<CrashSummary>"), false);
  assert.equal(isStringResult("Vec<PlanItem>"), false);
  assert.equal(isStringResult(""), false);
  // 只有一个参数不是 Result 的合法形态
  assert.equal(isStringResult("Result<X>"), false);
});

test("顶层切分不被嵌套尖括号带偏", () => {
  assert.deepEqual(splitTopLevel("HashMap<String, u32>, String"), ["HashMap<String, u32>", "String"]);
  assert.deepEqual(splitTopLevel("()"), ["()"]);
  assert.deepEqual(splitTopLevel("A, B, C"), ["A", "B", "C"]);
});

test("抽出命令名与返回类型（签名跨行也对）", () => {
  const src = `
/// 注释
#[tauri::command]
pub fn alpha(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
) -> Result<Vec<PlanItem>, String> {
    Ok(vec![])
}

#[tauri::command]
pub async fn beta(app: tauri::AppHandle) -> Result<(), AppError> {
    Ok(())
}

#[tauri::command]
pub fn gamma() {}
`;
  const cmds = scanCommands(src);
  assert.deepEqual(
    cmds.map((c) => c.name),
    ["alpha", "beta", "gamma"],
  );
  assert.equal(isStringResult(cmds[0].retType), true);
  assert.equal(isStringResult(cmds[1].retType), false);
  assert.equal(cmds[2].retType, "");
});

test("参数里的闭包箭头不会顶替真正的返回类型", () => {
  // 参数里出现 `->` 时，必须先跳到参数表结束再找返回类型
  const src = `
#[tauri::command]
pub fn run(job: impl Fn(i32) -> bool, name: String) -> Result<(), String> { Ok(()) }
`;
  const [cmd] = scanCommands(src);
  assert.equal(isStringResult(cmd.retType), true);
});

test("只收 Result<_, String> 的命令名，排序去重", () => {
  const src = `
#[tauri::command]
pub fn zed() -> Result<(), String> { Ok(()) }
#[tauri::command]
pub fn abc() -> Result<X, String> { todo!() }
#[tauri::command]
pub fn ok() -> Result<(), AppError> { Ok(()) }
`;
  assert.deepEqual(stringResultCommands(src), ["abc", "zed"]);
});

test("基线比较：新增红、已迁移只提示", () => {
  const diff = diffAgainstBaseline(["a", "b", "new"], ["a", "b", "gone"]);
  assert.deepEqual(diff.added, ["new"]);
  assert.deepEqual(diff.migrated, ["gone"]);
  assert.deepEqual(diff.staleExempt, []);
  assert.deepEqual(diffAgainstBaseline(["a"], ["a"]), { added: [], migrated: [], staleExempt: [] });
});

test("豁免表里的命令不算新增，但豁免本身要能提示过期", () => {
  const exempt = { waived: "族内一致" };
  // waived 在 current 里 → 放行，不出现在任何提示里
  const live = diffAgainstBaseline(["waived", "new"], [], exempt);
  assert.deepEqual(live.added, ["new"]);
  assert.deepEqual(live.staleExempt, []);
  // waived 已经不再返 String → 提示删豁免
  const stale = diffAgainstBaseline(["other"], [], exempt);
  assert.deepEqual(stale.staleExempt, ["waived"]);
});

test("基线两种形态都能读：裸数组与带 exempt 的对象", () => {
  assert.deepEqual(normalizeBaseline(["a", "b"]), { commands: ["a", "b"], exempt: {} });
  assert.deepEqual(normalizeBaseline({ commands: ["a"], exempt: { b: "理由" } }), {
    commands: ["a"],
    exempt: { b: "理由" },
  });
  // 空理由等于没写理由：豁免必须留痕，否则不算豁免
  assert.deepEqual(normalizeBaseline({ exempt: { b: "   " } }).exempt, {});
  assert.deepEqual(normalizeBaseline(null), { commands: [], exempt: {} });
});
