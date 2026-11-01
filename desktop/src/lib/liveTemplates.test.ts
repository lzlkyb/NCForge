import { describe, expect, it, vi } from "vitest";

const registered = vi.hoisted(() => ({ providers: [] as unknown[] }));

vi.mock("./monacoSetup", () => ({
  monaco: {
    languages: {
      CompletionItemKind: { Snippet: 15 },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      registerCompletionItemProvider: (_lang: string, provider: unknown) => {
        registered.providers.push(provider);
      },
    },
  },
}));

import { registerJavaTemplates, TEMPLATE_PREFIXES } from "./liveTemplates";

/** 取出注册进去的那个 provider，模拟一次补全。 */
const suggest = (prefixLen: number) => {
  registerJavaTemplates();
  const provider = registered.providers[0] as {
    provideCompletionItems: (
      m: unknown,
      p: unknown,
    ) => { suggestions: { label: string; insertText: string; insertTextRules?: number; sortText?: string }[] };
  };
  const model = {
    getWordUntilPosition: () => ({ startColumn: 1, endColumn: prefixLen + 1 }),
  };
  return provider.provideCompletionItems(model, { lineNumber: 3, column: prefixLen + 1 }).suggestions;
};

describe("Java live templates", () => {
  it("注册是幂等的（重复挂载不会叠出两份补全）", () => {
    registerJavaTemplates();
    registerJavaTemplates();
    expect(registered.providers).toHaveLength(1);
  });

  it("常见模板都在清单里，且前缀不重复", () => {
    for (const p of ["sout", "souf", "psvm", "fori", "iter", "tryc", "strnull", "soutv"]) {
      expect(TEMPLATE_PREFIXES).toContain(p);
    }
    expect(new Set(TEMPLATE_PREFIXES).size).toBe(TEMPLATE_PREFIXES.length);
  });

  it("必须走 InsertAsSnippet：否则 `${1:x}` 会原样打进代码里", () => {
    const s = suggest(4);
    const sout = s.find((x) => x.label === "sout")!;
    expect(sout.insertTextRules).toBe(4);
    expect(sout.insertText).toContain("$0");
  });

  it("排位靠后（zz- 前缀），敲半截时语义补全排前面", () => {
    const s = suggest(2);
    for (const it of s) expect(it.sortText?.startsWith("zz-")).toBe(true);
  });

  it("psvm 生成的是 main 方法骨架（换行 + 占位符）", () => {
    const psvm = suggest(4).find((x) => x.label === "psvm")!;
    expect(psvm.insertText).toContain("public static void main(String[] args)");
  });
});
