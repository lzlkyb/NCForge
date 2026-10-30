/**
 * 轻量 SQL 格式化（`Ctrl+Shift+F`）。
 *
 * 只做排障时最有用的那部分：主子句换行（select / from / where / group by / order by …）、
 * join 换行、where 里的 and / or 换行缩进、select 列表逗号后换行。关键字大小写不动——
 * 团队写法各异，改大小写只会让 SVN 里的 diff 变脏。
 *
 * 字符串、注释、括号内部（子查询、函数参数）原样保留：括号里的内容格式化风险大，收益小。
 */

type Tok = { t: "str" | "cmt" | "word" | "punct" | "ws"; v: string };

function tokenize(sql: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out.push({ t: "str", v: sql.slice(i, j + 1) });
      i = j + 1;
    } else if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      const e = nl < 0 ? n : nl;
      out.push({ t: "cmt", v: sql.slice(i, e) });
      i = e;
    } else if (c === "/" && sql[i + 1] === "*") {
      const e = sql.indexOf("*/", i + 2);
      const end = e < 0 ? n : e + 2;
      out.push({ t: "cmt", v: sql.slice(i, end) });
      i = end;
    } else if (/\s/.test(c)) {
      let j = i;
      while (j < n && /\s/.test(sql[j])) j++;
      out.push({ t: "ws", v: sql.slice(i, j) });
      i = j;
    } else if (/[\w$#.:]/.test(c)) {
      let j = i;
      while (j < n && /[\w$#.:]/.test(sql[j])) j++;
      out.push({ t: "word", v: sql.slice(i, j) });
      i = j;
    } else {
      out.push({ t: "punct", v: c });
      i++;
    }
  }
  return out;
}

/** 换行的主子句（可能是两个词）。 */
const CLAUSES = [
  "select", "from", "where", "group by", "order by", "having", "union all", "union", "minus",
  "intersect", "connect by", "start with", "set", "values", "into", "update", "delete", "insert",
];
const JOINS = ["left outer join", "right outer join", "full outer join", "left join", "right join", "full join", "inner join", "cross join", "join"];

/** 从第 k 个词开始，能否匹配某个多词短语；匹配上返回占用的 token 数。 */
function matchPhrase(words: Tok[], k: number, phrase: string): number {
  const parts = phrase.split(" ");
  let idx = k;
  for (let p = 0; p < parts.length; p++) {
    while (idx < words.length && words[idx].t === "ws") idx++;
    if (idx >= words.length || words[idx].t !== "word" || words[idx].v.toLowerCase() !== parts[p]) return 0;
    idx++;
  }
  return idx - k;
}

export function formatSql(sql: string): string {
  const toks = tokenize(sql.trim());
  let out = "";
  let depth = 0;
  let clause = "";
  const line = (indent: string) => {
    out = out.replace(/[ \t]+$/, "");
    if (out !== "" && !out.endsWith("\n")) out += "\n";
    out += indent;
  };
  for (let k = 0; k < toks.length; k++) {
    const tk = toks[k];
    if (tk.t === "ws") {
      if (depth > 0) out += tk.v.includes("\n") ? " " : tk.v;
      else if (!out.endsWith(" ") && !out.endsWith("\n") && out !== "") out += " ";
      continue;
    }
    if (tk.t === "punct") {
      if (tk.v === "(") depth++;
      if (tk.v === ")") depth = Math.max(0, depth - 1);
      if (tk.v === "," && depth === 0 && clause === "select") {
        out = out.replace(/\s+$/, "") + ",";
        line("       ");
        while (toks[k + 1]?.t === "ws") k++;
        continue;
      }
      out += tk.v;
      continue;
    }
    if (tk.t !== "word" || depth > 0) {
      out += tk.v;
      if (tk.t === "cmt" && tk.v.startsWith("--")) out += "\n";
      continue;
    }
    const lower = tk.v.toLowerCase();
    const phrase = [...CLAUSES, ...JOINS].find((p) => matchPhrase(toks, k, p) > 0);
    if (phrase) {
      const used = matchPhrase(toks, k, phrase);
      const text = toks.slice(k, k + used).filter((x) => x.t === "word").map((x) => x.v).join(" ");
      if (JOINS.includes(phrase)) line("  ");
      else line("");
      out += text;
      clause = JOINS.includes(phrase) ? clause : phrase;
      k += used - 1;
      continue;
    }
    if ((lower === "and" || lower === "or") && (clause === "where" || clause === "having" || clause === "")) {
      line("   ");
      out += tk.v;
      continue;
    }
    out += tk.v;
  }
  return out.replace(/[ \t]+\n/g, "\n").trim();
}
