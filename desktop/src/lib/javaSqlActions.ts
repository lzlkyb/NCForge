import { monaco } from "./monacoSetup";
import { extractSql } from "./sqlExtract";
import { requestExtract, type ExtractMode } from "./sqlExtractRequest";
import { toast } from "../components/ui/toast";

const ACTIONS: { id: string; label: string; mode: ExtractMode; order: number }[] = [
  { id: "ncforge.sql.run", label: "在数据库中执行此 SQL", mode: "run", order: 1 },
  { id: "ncforge.sql.explain", label: "查看此 SQL 的执行计划", mode: "explain", order: 2 },
  { id: "ncforge.sql.copy", label: "复制为纯 SQL", mode: "copy", order: 3 },
];

/**
 * Java 编辑器右键里的 SQL 动作：把光标处拼接的 SQL 拼回来（见 sqlExtract），交给 ExtractSqlDialog。
 * 只在 java 文件里出现。返回的 disposable 随编辑器一起释放。
 */
export function registerJavaSqlActions(editor: monaco.editor.IStandaloneCodeEditor): monaco.IDisposable[] {
  return ACTIONS.map((a) =>
    editor.addAction({
      id: a.id,
      label: a.label,
      precondition: "editorLangId == java",
      contextMenuGroupId: "9_ncforge_sql",
      contextMenuOrder: a.order,
      run: (ed) => {
        const model = ed.getModel();
        const pos = ed.getPosition();
        if (!model || !pos) return;
        const hit = extractSql(model.getValue(), model.getOffsetAt(pos));
        if (!hit) {
          toast("光标处没找到拼 SQL 的字符串（把光标放在 sql.append(\"…\") 那几行里）", "info");
          return;
        }
        // 没参数的复制不用弹框
        if (a.mode === "copy" && hit.params.length === 0) {
          void navigator.clipboard.writeText(hit.sql).then(() => toast("已复制拼好的 SQL", "success"));
          return;
        }
        requestExtract({ ...hit, file: model.uri.path, mode: a.mode });
      },
    }),
  );
}
