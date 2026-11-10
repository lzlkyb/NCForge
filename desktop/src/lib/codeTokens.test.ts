import {expect,it} from "vitest";
import {codeTokens} from "./codeTokens";
it("SQL注释、Oracle类型和带引号标识符分别着色，重组保留原文",()=>{
 const text='CREATE TABLE "NUMBER" (ID NUMBER DEFAULT 1, NAME VARCHAR2(20) DEFAULT \'-- x\'); -- 备注';
 const tokens=codeTokens(text);expect(tokens.map(token=>token.text).join("")).toBe(text);
 expect(tokens.find(token=>token.text==='"NUMBER"')?.kind).toBe("identifier");
 expect(tokens.find(token=>token.text==='NUMBER')?.kind).toBe("type");
 expect(tokens.find(token=>token.text==="'-- x'")?.kind).toBe("string");
});
it("大文本限制着色量但不截断复制源，JSON转义字符串保持安全文本",()=>{
 const text="select 1;\n".repeat(5000);const tokens=codeTokens(text);
 expect(tokens.map(token=>token.text).join("")).toBe(text);expect(tokens[tokens.length-1].kind).toBe("plain");
 const json=String.raw`{"a":"<img src=x>","b":"a\"b"}`;
 expect(codeTokens(json,"json").map(token=>token.text).join("")).toBe(json);
});
