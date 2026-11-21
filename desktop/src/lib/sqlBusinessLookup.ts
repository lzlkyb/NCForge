import { monaco } from "./monacoSetup";
import { openTableTab, rtOf, sqlColumnEpoch, sqlTabOf } from "./dbStore";
import { tabIdOfModel } from "./sqlModels";
import { sqlAssistScope } from "./sqlAssistLearning";
import { dialectOfSqlModel } from "./monacoSql";
import { sqlAssistColumns } from "./sqlAssistColumns";
import { peekSqlBusinessMetadata } from "./sqlBusiness";
import { sqlIdentifier } from "./sqlCompletionContext";
import { openSqlAssistPicker } from "./sqlAssistPicker";
import { toast } from "../components/ui/toast";

/** Match a known table label first. A lone field name must not scan every table in the connection. */
export function businessLookupTargets(phrase: string, labels: Readonly<Record<string, string>>) {
  const compact = (value: string) => value.replace(/[\s·：:]+/g, "").toLowerCase();
  const name = compact(phrase);
  if (!name || name.length > 120) return [];
  const matches = Object.entries(labels).flatMap(([table, label]) => {
    const full = compact(label), short = full.replace(/(?:单据主表|主表|主实体)$/, "");
    const prefix = full && name.startsWith(full) ? full : short && name.startsWith(short) ? short : "";
    return prefix ? [{ table, label, field: name.slice(prefix.length), prefix }] : [];
  });
  const longest = Math.max(0, ...matches.map(match => match.prefix.length));
  return matches.filter(match => match.prefix.length === longest).slice(0, 6);
}

export function wireSqlBusinessLookup(editor: monaco.editor.IStandaloneCodeEditor): monaco.IDisposable {
  return editor.addAction({
    id: "ncforge.sql.businessLookup", label: "按选中文字查找 NC 表和字段", contextMenuGroupId: "navigation", contextMenuOrder: 5,
    precondition: "editorHasSelection",
    async run() {
      const model = editor.getModel(), selection = editor.getSelection();
      const conn = model && sqlTabOf(tabIdOfModel(model))?.connId;
      if (!model || !selection || !conn || rtOf(conn).status !== "connected" || dialectOfSqlModel(model) !== "plsql") {
        toast("请连接 Oracle，再选中 NC 单据或单据与字段的中文名称", "info");
        return;
      }
      const phrase = model.getValueInRange(selection).trim();
      const rt = rtOf(conn), scope = sqlAssistScope(conn), version = model.getVersionId(), epoch = sqlColumnEpoch(conn);
      const tables = new Map(rt.tables?.map(table => [table.name.toLowerCase(), table]));
      const targets = businessLookupTargets(phrase, rt.ncNames ?? {}).flatMap(target => {
        const table = tables.get(target.table.toLowerCase());
        return table ? [{ ...target, object: table }] : [];
      });
      if (!scope || !targets.length) { toast("当前 Schema 未找到匹配的 NC 单据，请选中完整的单据中文名称", "info"); return; }
      const current = () => editor.getModel() === model && !model.isDisposed() && model.getVersionId() === version &&
        !!editor.getSelection()?.equalsRange(selection) && dialectOfSqlModel(model) === "plsql" &&
        sqlTabOf(tabIdOfModel(model))?.connId === conn && rtOf(conn).status === "connected" &&
        sqlColumnEpoch(conn) === epoch && sqlAssistScope(conn) === scope;
      await openSqlAssistPicker(editor, "NC 表和字段", "symbol-field", current, async valid => {
        const groups = await Promise.all(targets.map(async target => {
          const table = target.object;
          const id = (name: string) => sqlIdentifier(/^[A-Z][A-Z0-9_$#]*$/.test(name) ? name.toLowerCase() : name, "plsql");
          const apply = () => { if (current()) openTableTab(conn, table.name, "struct"); };
          if (!target.field) return [{ label: target.label, detail: table.name,
            preview: { text: `SELECT * FROM ${id(table.name)};`, note: "应用后打开表结构" }, apply }];
          const columns = await sqlAssistColumns(conn, id(table.name), valid, true);
          const meta = peekSqlBusinessMetadata(conn, scope, target.table);
          return columns.filter(column => column.name.toLowerCase().includes(target.field) ||
            column.zh?.replace(/\s+/g, "").includes(target.field)).slice(0, 12).map(column => {
            const relations = meta?.relations.filter(relation => !meta.sharedSession && relation.source.toLowerCase() === target.table.toLowerCase() &&
              relation.from.some(field => field.toLowerCase() === column.name.toLowerCase())) ?? [];
            const values = meta?.enums.filter(entry => !meta.sharedSession && entry.field.toLowerCase() === column.name.toLowerCase()) ?? [];
            const note = [target.label, column.full, column.pk && "主键",
              ...relations.slice(0, 2).map(relation => `${relation.kind} → ${relation.target}`),
              ...values.slice(0, 3).map(entry => `${entry.value} = ${entry.label}`), "应用后打开表结构"].filter(Boolean).join(" · ");
            return { label: column.zh || column.name, detail: `${table.name}.${column.name}`,
              preview: { text: `SELECT ${id(column.name)} FROM ${id(table.name)};`, note }, apply };
          });
        }));
        return groups.flat().slice(0, 20);
      });
    },
  });
}
