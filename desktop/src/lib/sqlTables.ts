/**
 * 从 SQL 里扫出涉及的表。
 *
 * 原本长在 `lib/mdDict.ts`（数据字典「补丁涉及」入口要用），但 SQL 结果的列中文名
 * 也要靠它定位「这条查询读了哪几张表」。留在字典模块里会让数据库控制台为了扫几个
 * 表名，把整个字典页的接口层一起引进来。这里只放纯函数，不碰 IPC，也不引 Monaco。
 */

export interface PatchTable {
  name: string;
  /** 第几段 SQL 扫到的（1 起）。补丁草稿的 sqls 没有文件名，只能这样定位。 */
  fromSql: number;
}

/**
 * 从若干段 SQL 里扫出涉及的表，按出现顺序去重（大小写不敏感）。
 *
 * 为什么不复用 `lib/db.ts::tableRefs`：那个只认 `from` / `join`，语义是「这条查询
 * 读了哪些表」，服务于 ORA-00942 的相似表建议。补丁包里的 SQL 大量是
 * `update ... set` / `insert into` / `merge into` / `truncate table`，用那个会漏掉
 * 大半个补丁 —— 「补丁涉及的表」漏了就等于字典缺表，还不报错。
 *
 * 扫之前先剥掉注释与字符串字面量：注释里写着 `-- 参考 from bd_xxx` 不该算，
 * `'select * from tmp'` 这种拼在字符串里的语句也不该算。
 *
 * `dual` 排除；`schema.table` 取末段（`aier.bd_material` → `bd_material`）。
 */
export function sqlTables(sqls: string[]): PatchTable[] {
  const seen = new Set<string>();
  const out: PatchTable[] = [];
  sqls.forEach((raw, i) => {
    for (const name of tablesInOne(raw)) {
      const k = name.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ name, fromSql: i + 1 });
    }
  });
  return out;
}

/** `from` / `join` / `into` / `table` 之后跟的那个标识符。 */
const REF_RE =
  /\b(?:(?:insert|merge)\s+into|(?:truncate|alter)\s+table|from|join|update)\s+([A-Za-z_][\w$#]*(?:\s*\.\s*[A-Za-z_][\w$#]*)?)/gi;

function tablesInOne(sql: string): string[] {
  const text = strip(sql);
  const out: string[] = [];
  REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REF_RE.exec(text)) !== null) {
    // `select ... from t for update nowait` 里的 update 不是 DML，别把 nowait 当表名
    if (isForUpdate(text, m.index)) continue;
    const parts = m[1].split(".").map((p) => p.trim());
    const name = parts[parts.length - 1];
    if (!name) continue;
    if (name.toLowerCase() === "dual") continue;
    out.push(name);
  }
  return out;
}

/** `update` 前面是不是 `for `（Oracle 的 `for update` 行锁）。 */
function isForUpdate(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 6), index).toLowerCase();
  return /for\s+$/.test(before);
}

/**
 * 剥掉 `--` 行注释、`/* *\/` 块注释与单引号字面量，用空格占位以免把前后词粘成一个。
 * 注释/字面量里出现 `from bd_x` 是常事（补丁 SQL 的说明、拼出来的动态语句）。
 */
function strip(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? n : nl + 1;
      out += " ";
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const e = sql.indexOf("*/", i + 2);
      i = e < 0 ? n : e + 2;
      out += " ";
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        // Oracle 里两个连续单引号是转义，不是结束
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          j += 1;
          break;
        }
        j += 1;
      }
      i = j;
      out += "'' ";
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}
