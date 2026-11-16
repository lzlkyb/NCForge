/**
 * 命令面板清单（P1-3）。
 *
 * 为什么不做"覆盖率百分比"：动作是在各组件挂载时动态注册的（`registerCommands`），
 * 静态代码里不存在一份"全部动作"的权威清单，任何百分比都是编出来的。
 * 这里只做可判定的事——把已注册命令、快捷键提示、缺失提示列成清单，
 * 让"新增动作有没有进面板"在 review 时有据可查。
 */

const ID_RE = /id:\s*["'`]([^"'`]+)["'`]/;
const TITLE_RE = /title:\s*(?:["'`]([^"'`]+)["'`]|`([^`]+)`)/;
const HINT_RE = /hint:\s*([^,\n]+)/;

/** `hint: "Ctrl+F9"` 与 `hint: KEY` 都要还原成可读文本，不能带引号。 */
export function cleanValue(raw) {
  const v = String(raw).trim().replace(/,$/, "");
  const quoted = /^["'`]([\s\S]*?)["'`]$/.exec(v);
  return quoted ? quoted[1] : v;
}

/**
 * 抽取命令。
 *
 * 判据是 `run:` 而不是"文件里出现过 registerCommands"：
 *   · 有的文件把命令数组定义在 `registerCommands(NAV_COMMANDS)` 之前（全文才有）；
 *   · 有的文件同时含静态快捷键表（`id: "fixed.save"` 但没有 run），只按位置过滤会漏。
 * 所以：全文找 `id:`，相邻 id 之间算一个对象，**对象里必须出现 `run:`** 才算命令。
 *
 * @returns {{id:string,title:string,hint:string|null,line:number}[]}
 */
export function extractCommands(text) {
  const lines = text.split("\n");
  const starts = [];
  lines.forEach((line, i) => {
    if (ID_RE.test(line)) starts.push(i);
  });

  const out = [];
  for (let k = 0; k < starts.length; k += 1) {
    const from = starts[k];
    const to = k + 1 < starts.length ? starts[k + 1] : Math.min(lines.length, from + 16);
    const chunk = lines.slice(from, to).join("\n");
    if (!/\brun\s*:/.test(chunk)) continue;

    const idMatch = lines[from].match(ID_RE);
    const titleMatch = chunk.match(TITLE_RE);
    const hintMatch = chunk.match(HINT_RE);
    out.push({
      id: idMatch[1],
      title: (titleMatch?.[1] ?? titleMatch?.[2] ?? "").trim(),
      hint: hintMatch ? cleanValue(hintMatch[1]) : null,
      line: from + 1,
    });
  }
  return out;
}

/** 每行文本是否属于命令对象内部——用来避免把无关的 `id:` 当命令。 */
export function summarize(files) {
  const byFile = [];
  const all = [];
  for (const file of files) {
    if (!/registerCommands\s*\(/.test(file.text)) continue;
    const cmds = extractCommands(file.text);
    if (!cmds.length) continue;
    for (const c of cmds) all.push({ ...c, file: file.path });
    byFile.push({ path: file.path, count: cmds.length, withHint: cmds.filter((c) => c.hint).length });
  }
  const missingHint = all.filter((c) => !c.hint);
  return { byFile, total: all.length, withHint: all.length - missingHint.length, missingHint };
}

function width(text) {
  let w = 0;
  for (const ch of String(text)) w += /[\u4e00-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
  return w;
}

export function formatReport(summary) {
  const head = ["注册点", "命令数", "有快捷键提示"];
  const rows = summary.byFile.map((f) => [f.path, String(f.count), String(f.withHint)]);
  const widths = head.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i]))));
  const pad = (s, w) => s + " ".repeat(Math.max(0, w - width(s)));
  const line = (cells) => cells.map((c, i) => pad(c, widths[i])).join("  ");
  const body = [
    line(head),
    widths.map((w) => "-".repeat(w)).join("  "),
    ...rows.map(line),
    widths.map((w) => "-".repeat(w)).join("  "),
    line(["合计", String(summary.total), String(summary.withHint)]),
  ];
  if (summary.missingHint.length) {
    body.push("", `没有快捷键提示的命令（${summary.missingHint.length} 条，只能从面板走）；`);
    for (const c of summary.missingHint) body.push(`  - ${c.file}:${c.line}  ${c.id}  ${c.title || "(无标题)"}`);
  }
  return body.join("\n");
}
