// Java 常用代码模板（Live Templates）。
//
// 为什么自己做而不是打开 jdt.ls 的 snippet 支持：模板是纯粹的编辑器功能，
// 不依赖语言服务是否就绪、文件是否在模块里。jdt.ls 自己也有一批模板，
// 但它的插入效果依赖客户端正确处理 `insertTextFormat=2`——那条我们也接上了
// （见 langProviders 的补全映射），两边的模板会一起出现在列表里。
//
// 语法是 Monaco 的 snippet：`$1` 占位、`${1:默认值}` 带默认文本、`$0` 收尾位置。
import { monaco } from "./monacoSetup";

interface Template {
  prefix: string;
  /** 列表里显示的说明。 */
  detail: string;
  body: string;
}

const TEMPLATES: Template[] = [
  { prefix: "sout", detail: "System.out.println", body: "System.out.println($1);$0" },
  { prefix: "souf", detail: "格式化输出", body: 'System.out.printf("$1%n", $2);$0' },
  { prefix: "serr", detail: "System.err.println", body: "System.err.println($1);$0" },
  {
    prefix: "psvm",
    detail: "main 方法",
    body: "public static void main(String[] args) {\n\t$0\n}",
  },
  {
    prefix: "fori",
    detail: "索引 for 循环",
    body: "for (int ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++) {\n\t$0\n}",
  },
  {
    prefix: "forr",
    detail: "倒序 for 循环",
    body: "for (int ${1:i} = ${2:n} - 1; ${1:i} >= 0; ${1:i}--) {\n\t$0\n}",
  },
  {
    prefix: "iter",
    detail: "增强 for 循环",
    body: "for (${1:Object} ${2:item} : ${3:items}) {\n\t$0\n}",
  },
  {
    prefix: "ifn",
    detail: "判空 if",
    body: "if ($1 == null) {\n\t$0\n}",
  },
  {
    prefix: "inn",
    detail: "非空 if",
    body: "if ($1 != null) {\n\t$0\n}",
  },
  {
    prefix: "ifnn",
    detail: "非空则执行（提前返回）",
    body: "if ($1 == null) {\n\treturn $0;\n}",
  },
  {
    prefix: "ifelse",
    detail: "if / else 双分支",
    body: "if ($1) {\n\t$2\n} else {\n\t$0\n}",
  },
  {
    prefix: "whilec",
    detail: "while 循环",
    body: "while ($1) {\n\t$0\n}",
  },
  {
    prefix: "swi",
    detail: "switch 分支",
    body: "switch (${1:value}) {\n\tcase ${2:CONST}:\n\t\t$0\n\t\tbreak;\n\tdefault:\n\t\tbreak;\n}",
  },
  {
    prefix: "tryc",
    detail: "try / catch",
    body: "try {\n\t$1\n} catch (${2:Exception} ${3:e}) {\n\t$0\n}",
  },
  {
    prefix: "tryf",
    detail: "try / finally",
    body: "try {\n\t$1\n} finally {\n\t$0\n}",
  },
  {
    prefix: "th",
    detail: "抛出异常",
    body: "throw new ${1:RuntimeException}($2);$0",
  },
  {
    prefix: "ins",
    detail: "instanceof 判断",
    body: "if ($1 instanceof ${2:Type}) {\n\t${2:Type} ${3:it} = (${2:Type}) $1;\n\t$0\n}",
  },
  {
    prefix: "strnull",
    detail: "字符串判空",
    body: "if ($1 == null || $1.trim().length() == 0) {\n\t$0\n}",
  },
  {
    prefix: "soutv",
    detail: "打印变量名和值",
    body: 'System.out.println("$1 = " + $1);$0',
  },
];

let registered = false;

/** 注册一次（幂等）。 */
export function registerJavaTemplates(): void {
  if (registered) return;
  registered = true;
  monaco.languages.registerCompletionItemProvider("java", {
    // 不给 triggerCharacters：模板靠「打字时按关键词过滤」触发，
    // 多一个触发字符只会让补全弹窗在奇怪的时候跳出来
    provideCompletionItems: (model, position) => {
      const word = model.getWordUntilPosition(position);
      // Monaco 在分组产生任何候选后便停止后续 provider；不匹配的模板会挡住单词补全。
      const matches = word.word ? TEMPLATES.filter(t => t.prefix.startsWith(word.word)) : [];
      if (!matches.length) return null;
      const range = {
        startLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endLineNumber: position.lineNumber,
        endColumn: word.endColumn,
      };
      return {
        suggestions: matches.map((t) => ({
          label: t.prefix,
          kind: monaco.languages.CompletionItemKind.Snippet,
          detail: t.detail,
          documentation: { value: "```java\n" + t.body.replace(/\$\{\d+:([^}]*)\}/g, "$1").replace(/\$\d/g, "") + "\n```" },
          // 模板排在语义补全之后（sortText 越大越靠后）：用户敲 `fo` 想要的是变量，
          // 敲完整 `fori` 时才想要模板
          sortText: `zz-${t.prefix}`,
          filterText: t.prefix,
          insertText: t.body,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
        })),
      };
    },
  });
}

/** 供设置页/文档引用：当前内置模板的清单。 */
export const TEMPLATE_PREFIXES = TEMPLATES.map((t) => t.prefix);
