import { useEffect, useState } from "react";
import { formatSql, sqlLanguageOf } from "../../lib/sqlFormat";
import { formatOptionsOf, SQL_DIALECTS, type SqlFormatPrefs } from "../../lib/sqlFormatPrefs";
import { useDbSelector } from "../../lib/dbStore";
import { SQL_FORMAT_SAMPLES } from "../../lib/sqlFormatSamples";
import { SqlHighlightedText } from "../db/SqlHighlightedText";

const metrics = (text: string) => {
  const lines = text.trimEnd() ? text.trimEnd().split("\n") : [];
  return `${lines.length} 行 · 最长 ${lines.reduce((max, line) => Math.max(max, line.length), 0)} 字符`;
};

export function SqlFormatPreview({ prefs }: { prefs: SqlFormatPrefs }) {
  const url = useDbSelector(s => {
    const id = s.tabs.find(tab => tab.id === s.active)?.connId;
    return id ? s.rt[id]?.info?.url ?? s.conns.find(conn => conn.id === id)?.url ?? "" : "";
  });
  const [sampleId, setSampleId] = useState("simple");
  const [custom, setCustom] = useState("");
  const [result, setResult] = useState<{ text?: string; error?: string }>({});
  const sample = SQL_FORMAT_SAMPLES.find(item => item.id === sampleId);
  const input = sample?.sql ?? custom;
  const language = prefs.dialect === "auto" && !url && sample?.language ? sample.language : sqlLanguageOf(url, prefs);
  useEffect(() => {
    let alive = true;
    setResult({});
    // Debounce pastes/typing; ignore an earlier async result after input or preferences change.
    const timer = setTimeout(() => {
      if (!input.trim()) { setResult({ text: "" }); return; }
      formatSql(input, language, formatOptionsOf(prefs)).then(
        text => { if (alive) setResult({ text }); },
        () => { if (alive) setResult({ error: "排版失败，原文已保留。请检查 SQL 是否完整，或调整方言后重试。" }); },
      );
    }, sampleId === "custom" ? 200 : 0);
    return () => { alive = false; clearTimeout(timer); };
  }, [prefs, input, language, sampleId]);
  const dialect = SQL_DIALECTS.find(item => item.value === language)?.label ?? "标准 SQL";
  return <figure className="settings-sql-preview">
    <figcaption>SQL 排版预览 <span>{prefs.dialect === "auto" && !url ? `无连接预览 · ${dialect}` : dialect} · 仅预览，不会执行</span></figcaption>
    <div className="settings-sql-preview-controls">
      <label htmlFor="sql-format-preview-sample">预览 SQL</label>
      <select id="sql-format-preview-sample" className="settings-select" value={sampleId} onChange={event => setSampleId(event.target.value)}>
        {SQL_FORMAT_SAMPLES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        <option value="custom">粘贴自己的 SQL</option>
      </select>
    </div>
    {sampleId === "custom" && <textarea className="settings-sql-input" aria-label="预览自己的 SQL" rows={6} spellCheck={false}
      placeholder="粘贴 SQL，在下方比较排版结果" value={custom} onChange={event => setCustom(event.target.value)} />}
    <div className="settings-sql-comparison">
      <div><h3>格式化前 <span>{metrics(input)}</span></h3><pre>{input ? <SqlHighlightedText text={input} dialect={language} /> : "请输入 SQL 查看预览"}</pre></div>
      <div><h3>格式化后 <span>{result.text !== undefined ? metrics(result.text) : ""}</span></h3>
        <pre aria-live="polite" role={result.error ? "alert" : undefined}>{result.error ?? (result.text === "" ? "请输入 SQL 查看预览" : result.text !== undefined ? <SqlHighlightedText text={result.text} dialect={language} /> : "正在生成预览…")}</pre>
      </div>
    </div>
  </figure>;
}
