// 「跳到测试 / 跳到被测」（IDEA 的 Ctrl+Shift+T）。
//
// 不用语言服务：NC 工程的测试类命名很规律（`XxxTest` / `TestXxx` / `XxxTests`），
// 按文件名找足够准，而且在 jdt.ls 没就绪时也能用。
//
// 找不到时给一条明确的话（"没有找到 XxxTest"），而不是静默——静默会让人以为快捷键坏了。
import { baseName, dirName } from "./workspace";
import { getFileIndex } from "./fileIndex";
import { getSession } from "./workspaceSession";
import { navigate } from "./lang";
import { toast } from "../components/ui/toast";

/** 测试类命名的常见形态，顺序 = 优先级。 */
const SUFFIXES = ["Test", "Tests", "TestCase", "IT"];
const PREFIXES = ["Test", "Abstract"];

/** 由类名推候选测试类名（`VoucherBO` → `VoucherBOTest` / `VoucherBOTests` / `TestVoucherBO`）。 */
export function testCandidates(stem: string): string[] {
  return [...SUFFIXES.map((s) => stem + s), ...PREFIXES.map((p) => p + stem)];
}

/** 反过来：当前是测试类，推出被测类名。推不出来返回空数组。 */
export function subjectCandidates(stem: string): string[] {
  const out: string[] = [];
  for (const s of SUFFIXES) {
    if (stem.endsWith(s) && stem.length > s.length) out.push(stem.slice(0, -s.length));
  }
  for (const p of PREFIXES) {
    if (stem.startsWith(p) && p !== "Abstract" && stem.length > p.length) out.push(stem.slice(p.length));
  }
  return out;
}

export interface TestLink {
  /** 要打开的完整路径。 */
  path: string;
  /** 是「从被测跳到测试」还是反过来。 */
  direction: "toTest" | "toSubject";
}

/**
 * 找配对的文件。
 *
 * 优先同目录（NC 里测试类常与被测类并排放在 `src/test`），其次全工作区按文件名找，
 * 最后才按「路径里含 test 目录」排序——避免在有几百个同名 `CommonTest` 的工程里抓瞎。
 */
export async function findTestPair(root: string, path: string): Promise<TestLink | null> {
  const name = baseName(path);
  if (!name.toLowerCase().endsWith(".java")) return null;
  const stem = name.slice(0, -5);
  const entries = await getFileIndex(root);

  const lookup = async (candidates: string[]): Promise<string | null> => {
    for (const c of candidates) {
      const sameDir = `${dirName(path)}\\${c}.java`;
      const hit = entries.find((e) => e.path.toLowerCase() === sameDir.toLowerCase());
      if (hit) return hit.path;
      const anywhere = entries.filter((e) => e.name.toLowerCase() === `${c.toLowerCase()}.java`);
      if (anywhere.length === 1) return anywhere[0].path;
      if (anywhere.length > 1) {
        // 多个同名：优先路径里带 test 的那个（标准布局里被测与测试分处 main/test）
        const preferred = anywhere.find((e) => /[\\/](test|tests)[\\/]/i.test(e.path)) ?? anywhere[0];
        return preferred.path;
      }
    }
    return null;
  };

  const toSubject = await lookup(subjectCandidates(stem));
  if (toSubject) return { path: toSubject, direction: "toSubject" };
  const toTest = await lookup(testCandidates(stem));
  return toTest ? { path: toTest, direction: "toTest" } : null;
}

/**
 * 命令 / 快捷键入口：在当前文件与它的测试之间来回跳。
 *
 * 找不到时**说清楚找过什么**（"没有找到 VoucherBOTest"），而不是静默——
 * 快捷键没反应时用户无法区分「没有配对」和「功能坏了」。
 */
export async function goToTestPair(path: string | null): Promise<void> {
  const root = getSession().root;
  if (!root || !path) {
    toast("先打开一个 Java 文件", "info");
    return;
  }
  const name = baseName(path);
  if (!name.toLowerCase().endsWith(".java")) {
    toast("只有 Java 文件有测试配对", "info");
    return;
  }
  const pair = await findTestPair(root, path);
  if (!pair) {
    const stem = name.slice(0, -5);
    toast(`没有找到 ${stem} 的测试类（找过 ${testCandidates(stem).join(" / ")}）`, "info");
    return;
  }
  navigate({ kind: "file", path: pair.path, line: 1, column: 1 });
  toast(pair.direction === "toTest" ? "已跳到测试类" : "已跳到被测类", "success");
}
