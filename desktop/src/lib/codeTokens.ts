export interface CodeToken {text:string;kind:string}
/** 仅词法着色，不执行HTML；超大文本后半段保留原文，避免创建数万个DOM节点。 */
export function codeTokens(text:string, language:"sql"|"json"="sql"):CodeToken[] {
  const tokens:CodeToken[]=[];
  const source=text.slice(0,20000);
  const pattern=/--[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:''|[^'])*'|"(?:\\.|""|[^"\\])*"|\b(?:select|from|where|join|on|and|or|not|null|true|false|create|alter|drop|table|index|insert|into|values|update|set|delete|as|order|by|group|having|primary|key|constraint|default|unique|check|references|begin|end|declare|procedure|function|return|is|in|between|like|commit|rollback)\b|\b(?:varchar2?|nvarchar2?|char|nchar|number|numeric|decimal|integer|float|date|timestamp|clob|blob|raw|boolean)\b|\b\d+(?:\.\d+)?\b/gi;
  let at=0;
  for (const match of source.matchAll(pattern)) {
    const i=match.index!,s=match[0];
    if(i>at) tokens.push({text:source.slice(at,i),kind:"plain"});
    const kind=/^(--|\/\*)/.test(s)?"comment":s[0]==="'"?"string":s[0]==='"'?(language==="json"?"string":"identifier"):/^\d/.test(s)?"number":/^(varchar2?|nvarchar2?|char|nchar|number|numeric|decimal|integer|float|date|timestamp|clob|blob|raw|boolean)$/i.test(s)?"type":"keyword";
    tokens.push({text:s,kind});at=i+s.length;
  }
  if(at<source.length) tokens.push({text:source.slice(at),kind:"plain"});
  if(source.length<text.length) tokens.push({text:text.slice(source.length),kind:"plain"});
  return tokens;
}
